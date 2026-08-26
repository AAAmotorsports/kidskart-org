-- =============================================================================
-- 貸切と当日 RP の受付制限 (2026-08 オーナー確認)
-- =============================================================================
--   * 貸切はカート 4 台以下では受け付けない (最小 5 台)
--   * 貸切は当日の申込を受け付けない (前日まで)
--   * 当日の RP は 17:00 以降の開始を受け付けない
--   * 当日の RP は 2 時間後以降のお時間のみ
--
-- いずれも aone_check_availability() に入れる。ここに入れておけば、
-- Web の予約フォーム・管理画面・予約者ページの変更のすべてで同じ判定になり、
-- 管理者は forced = true で従来どおり上書きできる。
--
-- 台数を見る必要があるので p_vehicles を足す。既存の 8 引数の呼び出しは
-- 既定値 null で通るが、同名 8 引数の関数が残っていると呼び分けが起きるため
-- 先に drop する。
-- =============================================================================

alter table aone_settings
  add column if not exists charter_min_lead_days    smallint not null default 1,
  add column if not exists rp_same_day_lead_minutes smallint not null default 120,
  add column if not exists rp_same_day_last_start   time     not null default '17:00';

comment on column aone_settings.charter_min_lead_days is
  '貸切を何日前までに申し込む必要があるか。1 = 前日まで (当日不可)';
comment on column aone_settings.rp_same_day_lead_minutes is
  '当日の RP を今から何分後以降で受けるか';
comment on column aone_settings.rp_same_day_last_start is
  '当日の RP の開始上限。この時刻以降は受け付けない (17:00 なら 16:30 が最終)';

drop function if exists aone_check_availability(text, date, text, text, time, time, integer, uuid);

create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null   -- 貸切のカート台数
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 天候による営業状態 (仕様 8)
  select weather_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', '本日は雨天中止です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 当日の RP は準備とスタッフの都合で制限がきびしい (2026-08 オーナー確認)
    if p_date = aone_today() then
      if p_start >= s.rp_same_day_last_start then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_late',
          'message', '本日のレースパックは ' || to_char(s.rp_same_day_last_start, 'HH24:MI')
            || ' より前の開始のみ承ります。お電話でご相談ください');
      end if;
      if ((p_date + p_start) at time zone 'Asia/Tokyo')
           < now() + make_interval(mins => s.rp_same_day_lead_minutes) then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_too_soon',
          'message', '本日のレースパックは ' || (s.rp_same_day_lead_minutes / 60)
            || ' 時間後以降のお時間でご予約ください。お急ぎの場合はお電話ください',
          'detail', jsonb_build_object('lead_minutes', s.rp_same_day_lead_minutes));
      end if;
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 当日の貸切は受けない (カートの準備が要る / 2026-08 オーナー確認)
    if p_date < aone_today() + s.charter_min_lead_days then
      return jsonb_build_object('ok', false, 'reason', 'charter_lead_time',
        'message', case when s.charter_min_lead_days = 1
          then '貸切は前日までのお申し込みとなります。当日はお電話でご相談ください'
          else '貸切は ' || s.charter_min_lead_days || ' 日前までのお申し込みとなります' end,
        'detail', jsonb_build_object('lead_days', s.charter_min_lead_days));
    end if;

    -- 最小台数を下回る申込は受けない
    if coalesce(p_vehicles, s.charter_min_karts) < s.charter_min_karts then
      return jsonb_build_object('ok', false, 'reason', 'charter_min_karts',
        'message', '貸切はカート ' || s.charter_min_karts || ' 台以上から承ります',
        'detail', jsonb_build_object('karts', p_vehicles, 'min', s.charter_min_karts));
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 台数を判定に渡す (それ以外は 0013 / 0004 と同じ)
-- -----------------------------------------------------------------------------
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
    v_party, null,
    nullif(payload->>'vehicle_count', '')::int);

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
    v_party, v_row.id,
    coalesce(nullif(payload->>'vehicle_count', '')::int, v_row.vehicle_count));

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

revoke all on function aone_create_reservation(jsonb) from public, anon, authenticated;
revoke all on function aone_update_reservation(jsonb) from public, anon, authenticated;
grant execute on function aone_create_reservation(jsonb) to service_role;
grant execute on function aone_update_reservation(jsonb) to service_role;
