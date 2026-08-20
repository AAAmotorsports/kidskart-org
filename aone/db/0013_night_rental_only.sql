-- =============================================================================
-- ナイターは「レースパック」か「貸切」のみ (2026-08 オーナー指示)
-- =============================================================================
-- ナイター走行はレンタルカートの商品としてのみ提供する。
-- 持ち込み (スポーツ走行) のナイターは受け付けない。
--
-- ナイターは従来どおり要相談 (status = checking) で受け、A-ONE が折り返す。
-- 通常営業時間外なので自動判定はしない。
--
-- 料金も RP / 貸切と同じ計算で入れる:
--   RP   … 人数 × 単価
--   貸切 … 基本料 + 台数 × 単価 (最小台数を下回らない)
-- =============================================================================

alter table aone_reservations
  add column if not exists night_kind text
  constraint aone_res_night_kind_chk check (night_kind is null or night_kind in ('rp', 'charter'));

comment on column aone_reservations.night_kind is
  'ナイターの内訳。rp = レースパック / charter = 貸切';

-- 料金計算: ナイターも内訳に応じて金額を入れる
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
declare
  s     aone_settings%rowtype;
  karts integer;
  v_as  text;   -- 料金計算上の種別 (ナイターは night_kind を使う)
begin
  if new.amount is not null then
    return new;
  end if;

  select * into s from aone_settings where id = 1;

  v_as := case when new.kind = 'night' then new.night_kind else new.kind end;

  if v_as = 'rp' then
    new.amount := coalesce(new.party_size, 0) * s.rp_price_per_person;

  elsif v_as = 'charter' then
    -- 台数未指定なら最小台数で見積もる (確定時にスタッフが直す)
    karts := greatest(coalesce(new.vehicle_count, s.charter_min_karts), s.charter_min_karts);
    new.amount := s.charter_base_price + s.charter_price_per_kart * karts;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

-- 予約作成 RPC に night_kind を通す (それ以外は 0004 と同じ)
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
    kind, status, date, session, start_time, end_time, category_code, night_kind,
    party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    nullif(payload->>'night_kind', ''),
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
    'night_kind', v_row.night_kind,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;
