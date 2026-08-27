-- =============================================================================
-- 営業状況と路面状況を分ける
-- =============================================================================
-- 2026-08 オーナー指示:
--
--   営業状況 … 基本は「営業中」。休みの日は「休業」。臨時休業は管理画面で設定。
--   路面状況 … 営業状況とは別軸。ドライ / ウェット / ウェット→ドライ / ヘビーウェット
--
-- これまでは weather_status 1 本に「通常営業・雨天注意・営業確認中・
-- 路面回復待ち・雨天中止」が混ざっていた。「営業しているが路面はウェット」と
-- 「休業」を同じ列で表せないので、お客様に伝えたいことが伝わらなかった。
--
--   business_status … 営業しているか (受付可否に影響する)
--   surface_status  … 走ってみた路面の状態 (受付可否には一切影響しない)
--
-- 旧値からの読み替え:
--   normal           → open     / 路面なし
--   rain_caution     → open     / wet
--   checking         → checking / 路面なし
--   surface_recovery → open     / drying
--   cancelled        → cancelled/ 路面なし
--   other            → open     / 路面なし
--
-- ★ この設定を変えてもお客様には自動でメールを送らない。
--   急な休みは電話で連絡する運用のため (お知らせは一括連絡・個別連絡から手動で送る)。
-- =============================================================================

alter table aone_business_days
  add column if not exists business_status text not null default 'open'
    check (business_status in (
      'open',      -- 営業中 (既定)
      'checking',  -- 営業確認中 (走れるか判断中)
      'cancelled', -- 走行中止 (営業日だが天候等で走れない)
      'closed'     -- 休業
    )),
  add column if not exists surface_status text
    check (surface_status in (
      'dry',       -- ドライ
      'wet',       -- ウェット
      'drying',    -- ウェット→ドライ
      'heavy_wet'  -- ヘビーウェット
    ));

comment on column aone_business_days.business_status is
  '営業状況。受付可否に影響する (closed / cancelled は予約を止める)';
comment on column aone_business_days.surface_status is
  '路面状況。表示のみで受付可否には影響しない。null = 未設定 (表示しない)';

-- 旧 weather_status からの読み替え (既に business_status を触っている行は上書きしない)
update aone_business_days set
  business_status = case weather_status
    when 'checking'  then 'checking'
    when 'cancelled' then 'cancelled'
    else 'open' end,
  surface_status = case weather_status
    when 'rain_caution'     then 'wet'
    when 'surface_recovery' then 'drying'
    else null end
where business_status = 'open' and surface_status is null
  and weather_status is not null and weather_status <> 'normal';

-- weather_status は読まなくなった。列は履歴として残すが、既定値と NOT NULL を外して
-- 「ここを書いても何も起きない」ことをはっきりさせる。
alter table aone_business_days alter column weather_status drop default;
alter table aone_business_days alter column weather_status drop not null;
comment on column aone_business_days.weather_status is
  '廃止列。どこからも読んでいない。営業状況は business_status、路面は surface_status を使う';

-- -----------------------------------------------------------------------------
-- 受付判定: 休業・走行中止は予約を止める (路面状況は止めない)
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

-- -----------------------------------------------------------------------------
-- 日別ダイジェスト: business (営業状況) と surface (路面状況) を別々に返す
-- -----------------------------------------------------------------------------
create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
  v_biz      text;
  v_biz_src  text;
  v_surface  text;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.business_status, bd.surface_status, bd.status_message, bd.staff_note
    into v_weather
  from aone_business_days bd where bd.date = p_date;

  v_biz     := coalesce(v_weather.business_status, 'open');
  v_biz_src := 'manual';
  v_surface := v_weather.surface_status;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- 臨時休業を予定として登録してあれば、営業状況は自動で「休業」になる。
  -- 予定と当日の表示を二重に入力させない (入力が 2 か所あると必ず片方が腐る)。
  if v_biz = 'open' and exists (
    select 1 from aone_blocks b
    where b.date = p_date and b.kind = 'closed' and b.scope = 'all'
  ) then
    v_biz     := 'closed';
    v_biz_src := 'block';
  end if;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        -- スポーツ走行に「残りわずか (△)」は出さない (2026-08 オーナー指示)。
        -- 利用者が知りたいのは「走れるか / 走れないか」だけで、△ は迷わせるだけ。
        -- 残りクラス数はスタッフが used_classes / max_classes で把握できる。
        v_status := 'open';
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'business_closed', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        -- 予約が必要なカテゴリーか (false = 飛び込みでも走れる)
        'requires_reservation', v_cat.requires_reservation,
        -- true = 予約フォームに出さない (管理画面からの代理入力のみ受け付ける)
        'admin_only', v_cat.admin_only,
        -- 予約なしで今そのまま走れるか
        'walk_in_ok', v_status in ('open','limited')
                      and (not v_cat.requires_reservation or coalesce(v_has_cat, false)),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'business', jsonb_build_object(
      'status',     v_biz,
      'source',     v_biz_src,
      'message',    v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'surface', jsonb_build_object('status', v_surface),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;



alter function aone_day_state(date) security definer set search_path = public, pg_temp;
grant execute on function aone_day_state(date) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 月ダイジェストも同じ 2 軸で返す
-- -----------------------------------------------------------------------------
create or replace function aone_month_state(p_year integer, p_month integer) returns jsonb
language sql stable as $$
  with days as (
    select generate_series(
      make_date(p_year, p_month, 1),
      (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
      interval '1 day')::date as d
  ),
  -- MATERIALIZED が必須: 付けないと下で st を参照するたびに
  -- aone_day_state() が再評価され、1 か月ぶんで数秒かかる。
  states as materialized (
    select d, aone_day_state(d) as st from days
  )
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'),
      'dow', extract(dow from d)::int,
      'is_holiday', st->>'is_holiday' = 'true',
      'business', st->'business'->>'status',
      'surface', st->'surface'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
      -- カテゴリーごとの状態 (何が走れるかを出すため)
      'am_categories', st->'sport'->'am'->'categories',
      'pm_categories', st->'sport'->'pm'->'categories',
      'rp_free', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                   where (s->>'accepting')::boolean),
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                          'title', b->>'title',
                          'public_label', b->>'public_label',
                          'kind', b->>'kind',
                          'is_public', (b->>'is_public')::boolean)), '[]'::jsonb)
                 from jsonb_array_elements(st->'blocks') b),
      'counts', st->'counts'
    ) as x
    from states
  ) y;
$$;

alter function aone_month_state(integer, integer) security definer set search_path = public, pg_temp;
grant execute on function aone_month_state(integer, integer) to anon, authenticated, service_role;
