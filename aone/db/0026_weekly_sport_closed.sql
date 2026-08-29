-- =============================================================================
-- 毎週の定休 (曜日 × 午前/午後 でスポーツ走行を止める)
-- =============================================================================
-- 2026-08 オーナー指示:
--
--   「日曜日の午後はスポーツ走行の予約は基本受けない」
--
-- 日付ではなく **曜日**で決まる決め事なので、ブロック予定 (aone_blocks) では
-- 表せない。毎週ぶんを登録する運用にすると、必ずいつか入れ忘れる。
--
--   * 止めるのは **スポーツ走行だけ**。RP・貸切・ナイターは通常どおり受ける
--     (日曜午後こそレンタルのお客様が来る時間帯)
--   * 「基本」なので、管理者は今までどおり `forced = true` で入れられる
--   * すでに入っている予約は消えない (§8.1 と同じ。効くのはこれから受ける予約だけ)
--   * 設定は /admin/settings の 曜日 × AM/PM のチェックで変えられる
-- =============================================================================

create table if not exists aone_weekly_sport_closed (
  -- 0 = 日曜 (postgres の extract(dow) に合わせる)
  dow     smallint not null check (dow between 0 and 6),
  session text     not null check (session in ('am', 'pm')),
  primary key (dow, session)
);

comment on table aone_weekly_sport_closed is
  '毎週この曜日・この時間帯はスポーツ走行を受け付けない、という決め事';

alter table aone_weekly_sport_closed enable row level security;

-- 公開ページも「日曜午後は ✕」と出すため、読むだけは誰でもできる
drop policy if exists aone_weekly_sport_closed_read on aone_weekly_sport_closed;
create policy aone_weekly_sport_closed_read on aone_weekly_sport_closed
  for select using (true);

-- ⚠ 0005 の `grant all on all tables in schema public to service_role` は
--   その時点で存在したテーブルにしか効かない (0022 で実際に踏んだ)
grant select on aone_weekly_sport_closed to anon, authenticated;
grant all on aone_weekly_sport_closed to service_role;

-- 日曜の午後を止める (オーナー指示の初期値)
insert into aone_weekly_sport_closed (dow, session) values (0, 'pm')
on conflict do nothing;

-- 曜日の日本語 (メッセージ用)
create or replace function aone_weekday_ja(p_date date) returns text
language sql immutable as $$
  select ('{日,月,火,水,木,金,土}'::text[])[extract(dow from p_date)::int + 1] || '曜日';
$$;

grant execute on function aone_weekday_ja(date) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 受付判定に毎週の定休を足す
-- -----------------------------------------------------------------------------
create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null,  -- 貸切のカート台数
  p_charter  text default null      -- 貸切の種別 (with_karts / course_only)
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

  -- 営業状況 (仕様 8) — 休業・走行中止は受け付けない。
  -- 路面状況 (surface_status) は表示だけで、ここでは一切見ない。
  select business_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', 'この日は走行中止となっています');
  elsif v_weather = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'business_closed',
      'message', 'この日は休業日です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 毎週の定休 (2026-08 オーナー指示)。
  -- 「日曜の午後はスポーツ走行を受けない」のような、日付ではなく曜日で決まる決め事。
  -- ブロック予定と違って登録しっぱなしで効き続ける (毎年入れ直さなくてよい)。
  -- ★ 止めるのはスポーツ走行だけ。RP・貸切・ナイターは通常どおり受け付ける
  if p_kind = 'sport' and exists (
    select 1 from aone_weekly_sport_closed w
    where w.dow = extract(dow from p_date)::smallint and w.session = p_session
  ) then
    return jsonb_build_object('ok', false, 'reason', 'weekly_closed',
      'message', aone_weekday_ja(p_date) || 'の' ||
        case p_session when 'am' then '午前' else '午後' end ||
        'はスポーツ走行の受付をお休みしています',
      'detail', jsonb_build_object('dow', extract(dow from p_date)::int, 'session', p_session));
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

    -- コース貸切のみ (レンタルカート無し) は都度見積り。必ず折り返す
    if p_charter = 'course_only' then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'course_only',
        'message', 'コースのみの貸切は内容により料金が変わります。A-ONE より折り返しご連絡いたします');
    end if;

    -- 最小台数を下回る申込は受けない (レンタルカート付きのみ)
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

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  to anon, authenticated, service_role;
