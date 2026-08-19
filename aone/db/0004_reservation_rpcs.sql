-- =============================================================================
-- A-ONE 予約システム — 予約の作成 / 変更 / キャンセル RPC
-- =============================================================================
-- Web も電話も店頭も、すべてこの RPC を通す (仕様 13: 予約台帳を分けない)。
--
-- 同時実行対策: 日付単位の advisory lock を取ってから空き判定 → INSERT まで
-- を 1 トランザクションで行う。REST 経由の 2 リクエストが同じ最後の 1 クラスを
-- 取り合っても、後から来た方は必ず class_full で弾かれる。
--
-- エラーは SQLSTATE 'AONE1' + HINT に理由コードを載せて返す。
-- API 層 (Astro) はその理由コードを HTTP ステータスに写像する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 顧客の名寄せ (仕様 16: 電話番号・メールを基準に履歴をまとめる)
-- -----------------------------------------------------------------------------
create or replace function aone_upsert_customer(
  p_name  text,
  p_kana  text,
  p_phone text,
  p_email text
) returns uuid
language plpgsql volatile as $$
declare
  v_id    uuid;
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  if v_email is not null then
    select id into v_id from aone_customers where lower(email) = v_email limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from aone_customers
    where regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') = v_phone
    order by created_at
    limit 1;
  end if;

  if v_id is null then
    insert into aone_customers (name, kana, phone, email)
    values (coalesce(nullif(trim(p_name), ''), '(名前未登録)'), nullif(trim(p_kana), ''),
            nullif(trim(p_phone), ''), v_email)
    returning id into v_id;
    return v_id;
  end if;

  -- 既存顧客: 空欄だけ埋める (スタッフが直した表記を Web 入力で潰さない)
  update aone_customers
     set kana  = coalesce(kana,  nullif(trim(p_kana), '')),
         phone = coalesce(nullif(trim(phone), ''), nullif(trim(p_phone), '')),
         email = coalesce(nullif(lower(trim(email)), ''), v_email)
   where id = v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 予約作成
-- -----------------------------------------------------------------------------
-- payload:
-- {
--   kind: 'sport'|'rp'|'charter'|'night',
--   date: '2026-08-23',
--   session: 'am'|'pm',            -- sport
--   category_code: 'kart',         -- sport / night
--   start_time: '14:00',           -- rp / charter / night
--   end_time: '17:00',             -- charter
--   party_size: 5, vehicle_count: 2,
--   contact: { name, kana, phone, email },
--   preferred_contact: 'email'|'phone',
--   source: 'web'|'phone'|'counter'|'admin',
--   request_note, staff_memo, amount,
--   terms_agreed: true,
--   forced: false, forced_reason: '',   -- 管理者の強制受付 (仕様 15)
--   created_by: 'admin'
-- }
create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null);

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code,
    party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', '')
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 予約変更 (仕様 4 / 10: 予約者専用 URL から時間・人数を変更)
-- -----------------------------------------------------------------------------
-- payload: { access_token | id, start_time?, end_time?, session?, category_code?,
--            party_size?, vehicle_count?, contact{...}?, request_note?,
--            date?,                        -- 管理者のみ
--            forced?, actor? }
create or replace function aone_update_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s        aone_settings%rowtype;
  v_row    aone_reservations%rowtype;
  v_before jsonb;
  v_date   date;
  v_start  time;
  v_end    time;
  v_sess   text;
  v_cat    text;
  v_party  integer;
  v_forced boolean := coalesce((payload->>'forced')::boolean, false);
  v_check  jsonb;
  v_status text;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    raise exception 'この予約は既にキャンセルされています' using errcode = 'AONE1', hint = 'already_cancelled';
  end if;

  v_before := to_jsonb(v_row);

  v_date  := coalesce(nullif(payload->>'date', '')::date, v_row.date);
  v_sess  := coalesce(nullif(payload->>'session', ''), v_row.session);
  v_cat   := coalesce(nullif(payload->>'category_code', ''), v_row.category_code);
  v_party := coalesce(nullif(payload->>'party_size', '')::int, v_row.party_size);
  v_start := coalesce(nullif(payload->>'start_time', '')::time, v_row.start_time);
  v_end   := nullif(payload->>'end_time', '')::time;

  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  if v_row.kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;
  elsif v_row.kind = 'rp' then
    v_end := coalesce(v_end, (v_start + make_interval(mins => s.rp_duration_minutes))::time);
  else
    v_end := coalesce(v_end, v_row.end_time);
  end if;

  -- 自分自身を除外して再判定 (仕様 4: 変更時に最新の空き状況を再判定)
  v_check := aone_check_availability(
    v_row.kind, v_date, v_cat, v_sess,
    case when v_row.kind = 'sport' then null else v_start end,
    case when v_row.kind = 'sport' then null else v_end end,
    v_party, v_row.id);

  if not (v_check->>'ok')::boolean and not v_forced then
    raise exception '%', v_check->>'message'
      using errcode = 'AONE1', hint = v_check->>'reason';
  end if;

  -- 確定済みの予約は、変更後も確定のまま維持する (要相談枠に落ちた場合を除く)
  v_status := case
    when v_row.status in ('confirmed', 'completed') and (v_check->>'status') = 'checking'
      then 'checking'
    else v_row.status
  end;

  update aone_reservations set
    date          = v_date,
    session       = v_sess,
    category_code = v_cat,
    start_time    = v_start,
    end_time      = v_end,
    party_size    = v_party,
    vehicle_count = coalesce(nullif(payload->>'vehicle_count', '')::int, vehicle_count),
    status        = v_status,
    contact_name  = coalesce(nullif(trim(payload->'contact'->>'name'), ''), contact_name),
    contact_kana  = coalesce(nullif(trim(payload->'contact'->>'kana'), ''), contact_kana),
    contact_phone = coalesce(nullif(trim(payload->'contact'->>'phone'), ''), contact_phone),
    contact_email = coalesce(nullif(lower(trim(payload->'contact'->>'email')), ''), contact_email),
    request_note  = coalesce(nullif(payload->>'request_note', ''), request_note),
    staff_memo    = coalesce(nullif(payload->>'staff_memo', ''), staff_memo),
    amount        = coalesce(nullif(payload->>'amount', '')::int, amount),
    forced        = forced or (v_forced and not (v_check->>'ok')::boolean)
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'updated', coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('before', v_before - 'access_token', 'check', v_check));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- キャンセル / 無断キャンセル (仕様 9)
-- -----------------------------------------------------------------------------
-- payload: { access_token | id, reason?, actor?, no_show? }
--
-- スポーツ走行は当日でも連絡があればキャンセル可・キャンセル料なし。
-- RP / 貸切は開始 24 時間前以降のキャンセルは料金 100% だが、システムは
-- 「キャンセル自体は受け付けて、料金発生フラグを返す」方針にする
-- (現場で個別対応できるようにするため — 仕様 20)。
create or replace function aone_cancel_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s          aone_settings%rowtype;
  v_row      aone_reservations%rowtype;
  v_no_show  boolean := coalesce((payload->>'no_show')::boolean, false);
  v_start_ts timestamptz;
  v_fee      boolean := false;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status,
                              'already', true, 'cancel_fee', false);
  end if;

  -- キャンセル料の判定 (RP / 貸切のみ)
  if v_row.kind in ('rp', 'charter') then
    v_start_ts := (v_row.date + coalesce(v_row.start_time, time '00:00'))
                    at time zone 'Asia/Tokyo';
    v_fee := (v_start_ts - now()) < make_interval(hours => s.rp_cancel_deadline_hours);
  end if;

  update aone_reservations set
    status        = case when v_no_show then 'no_show' else 'cancelled' end,
    cancelled_at  = now(),
    cancel_reason = nullif(payload->>'reason', ''),
    cancelled_by  = coalesce(nullif(payload->>'actor', ''), 'customer')
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_no_show then 'no_show' else 'cancelled' end,
          coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('reason', payload->>'reason', 'cancel_fee', v_fee));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'cancel_fee', v_fee,
    'cancel_deadline_hours', s.rp_cancel_deadline_hours
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- ステータス変更 (管理画面: 受付 → 連絡待ち → 確認中 → 確定 → 完了)
-- -----------------------------------------------------------------------------
create or replace function aone_set_reservation_status(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row    aone_reservations%rowtype;
  v_status text := payload->>'status';
begin
  if v_status is null then
    raise exception 'status は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;

  update aone_reservations
     set status = v_status,
         cancelled_at  = case when v_status in ('cancelled','no_show') then coalesce(cancelled_at, now()) else null end,
         cancel_reason = case when v_status in ('cancelled','no_show') then coalesce(cancel_reason, nullif(payload->>'reason','')) else null end,
         is_paid       = coalesce((payload->>'is_paid')::boolean, is_paid),
         staff_memo    = coalesce(nullif(payload->>'staff_memo',''), staff_memo)
   where id = (payload->>'id')::uuid
  returning * into v_row;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'status', coalesce(nullif(payload->>'actor',''), 'admin'),
          jsonb_build_object('status', v_status));

  return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status);
end;
$$;
