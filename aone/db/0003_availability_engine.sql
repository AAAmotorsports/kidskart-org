-- =============================================================================
-- A-ONE 予約システム — 受付可否ルールエンジン
-- =============================================================================
-- ★ このファイルが受付ルールの **唯一の正** です。
--   画面 (Astro) は aone_day_state() / aone_check_availability() の結果を
--   表示するだけで、同じルールを TypeScript 側に再実装してはいけません。
--   (二重実装するとカレンダーの表示と実際の受付結果がズレる)
--
-- ルール要約
--   スポーツ走行 (仕様 2)
--     * 同一カテゴリーは何台入っても 1 クラス
--     * 平日 午前/午後 2 クラス、土日祝 午前 2 クラス・午後 1 クラス
--   RP (仕様 3)
--     * 3 名以上、10:00〜17:00 の 30 分刻み (17:00 以降は要相談)
--     * 同一開始時刻は 2 グループまで
--     * RP が同時 3 グループ以上になった時間帯はスポーツ走行の新規受付停止
--   貸切 (仕様 5)
--     * 他予約が無ければ受付 → 確定でその時間帯の他予約を全停止
--     * 他予約があれば申込は受けるが「連絡待ち」扱い
--   ナイター (仕様 6)
--     * 常に要相談 (確認中で受付)
--   管理者は forced = true ですべてを上書きできる (仕様 15)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 土日祝判定
-- -----------------------------------------------------------------------------
create or replace function aone_is_holiday(p_date date) returns boolean
language sql stable as $$
  select extract(dow from p_date) in (0, 6)
      or exists (select 1 from aone_holidays h where h.date = p_date);
$$;

-- 今日 (JST)
create or replace function aone_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;

-- -----------------------------------------------------------------------------
-- セッション (午前/午後) の走行時間帯
-- -----------------------------------------------------------------------------
create or replace function aone_session_window(p_session text)
returns table (start_time time, end_time time)
language sql stable as $$
  select
    case when p_session = 'am' then s.am_start_time else s.pm_start_time end,
    case when p_session = 'am' then s.am_end_time   else s.pm_end_time   end
  from aone_settings s where s.id = 1;
$$;

-- -----------------------------------------------------------------------------
-- ブロック予定がある予約要求に当たるか
-- -----------------------------------------------------------------------------
-- p_kind      : 'sport' | 'rp' | 'charter' | 'night'
-- p_category  : スポーツ走行のカテゴリー (それ以外は null)
-- p_start/p_end: 対象の時間帯 (スポーツ走行はセッションの走行時間)
create or replace function aone_blocking_blocks(
  p_date     date,
  p_kind     text,
  p_category text,
  p_start    time,
  p_end      time
)
returns table (id uuid, title text, kind text, scope text)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  win as (
    select b.*,
      case b.scope
        when 'am'   then (select course_open_time from s)
        when 'pm'   then (select pm_start_time    from s)
        when 'time' then coalesce(b.start_time, time '00:00')
        else coalesce(b.start_time, time '00:00')
      end as w_start,
      case b.scope
        when 'am'   then (select am_end_time       from s)
        when 'pm'   then (select course_close_time from s)
        when 'time' then coalesce(b.end_time, time '23:59:59')
        else coalesce(b.end_time, time '23:59:59')
      end as w_end
    from aone_blocks b
    where b.date = p_date
  )
  select w.id, w.title, w.kind, w.scope
  from win w
  where
    -- 対象の予約種別に効くか
    case
      when w.scope = 'sport'    then p_kind = 'sport'
      when w.scope = 'rp'       then p_kind = 'rp'
      when w.scope = 'category' then p_kind = 'sport'
                                  and (w.category_code is null or w.category_code = p_category)
      else
        case p_kind
          when 'sport'   then w.blocks_sport
          when 'night'   then w.blocks_sport
          when 'rp'      then w.blocks_rp
          when 'charter' then w.blocks_charter
          else true
        end
    end
    -- 時間帯が重なるか (時刻未指定のブロックは終日扱い)
    and w.w_start < coalesce(p_end, time '23:59:59')
    and w.w_end   > coalesce(p_start, time '00:00');
$$;

-- -----------------------------------------------------------------------------
-- 指定時間帯に重なる「生きている」予約
-- -----------------------------------------------------------------------------
-- RP / 貸切 / ナイターは start_time〜end_time、スポーツ走行は session の
-- 走行時間帯を占有しているものとして扱う。
create or replace function aone_live_reservations_in_window(
  p_date    date,
  p_start   time,
  p_end     time,
  p_exclude uuid default null
)
returns table (
  id uuid, kind text, status text, start_time time, end_time time,
  category_code text, party_size smallint, contact_name text
)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  expanded as (
    select r.id, r.kind, r.status, r.category_code, r.party_size, r.contact_name,
      case
        when r.kind = 'sport' and r.session = 'am' then (select am_start_time from s)
        when r.kind = 'sport' and r.session = 'pm' then (select pm_start_time from s)
        else r.start_time
      end as w_start,
      case
        when r.kind = 'sport' and r.session = 'am' then (select am_end_time from s)
        when r.kind = 'sport' and r.session = 'pm' then (select pm_end_time from s)
        when r.kind = 'rp' then coalesce(
          r.end_time,
          (r.start_time + make_interval(mins => (select rp_duration_minutes from s)))::time)
        else coalesce(r.end_time, (r.start_time + interval '1 hour')::time)
      end as w_end
    from aone_reservations r
    where r.date = p_date
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude)
  )
  select e.id, e.kind, e.status, e.w_start, e.w_end, e.category_code, e.party_size, e.contact_name
  from expanded e
  where e.w_start < coalesce(p_end, time '23:59:59')
    and e.w_end   > coalesce(p_start, time '00:00');
$$;

-- -----------------------------------------------------------------------------
-- 指定時間帯における RP の同時グループ数のピーク
-- -----------------------------------------------------------------------------
-- 「その時間帯に RP が何組重なっているか」の最大値。
-- スポーツ走行を止めるかどうか (rp_groups_block_sport) の判定に使う。
create or replace function aone_rp_peak_groups(
  p_date    date,
  p_start   time,
  p_end     time,
  p_exclude uuid default null
) returns integer
language sql stable as $$
  with rp as (
    select l.id, l.start_time, l.end_time
    from aone_live_reservations_in_window(p_date, p_start, p_end, p_exclude) l
    where l.kind = 'rp'
  ),
  -- 判定点: 各グループの開始時刻と対象時間帯の開始時刻
  points as (
    select start_time as t from rp
    union select coalesce(p_start, time '00:00')
  )
  select coalesce(max(c), 0)::int from (
    select (select count(*) from rp
             where rp.start_time <= p.t and rp.end_time > p.t) as c
    from points p
    where p.t < coalesce(p_end, time '23:59:59')
  ) x;
$$;

-- -----------------------------------------------------------------------------
-- 受付可否の判定 (中核)
-- -----------------------------------------------------------------------------
-- 戻り値 jsonb:
--   { ok: bool, status: '確定させるべき status', reason: 'コード',
--     message: '日本語の説明', detail: {...} }
create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null
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

-- -----------------------------------------------------------------------------
-- 1 日ぶんの状態 (「今日走れる？」/ 管理カレンダー/ 予約フォームの共通ソース)
-- -----------------------------------------------------------------------------
-- カテゴリー状態:
--   'open'    ○ 受付可
--   'limited' △ 残りわずか (このカテゴリーを入れると上限、または RP があと 1 組で停止)
--   'closed'  ✕ 受付停止 (クラス上限 / RP 飽和 / 貸切)
--   'off'     — 対象外 (雨天中止 / 終日ブロック / 過去日)
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
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.weather_status, bd.status_message, bd.staff_note into v_weather
  from aone_business_days bd where bd.date = p_date;

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
        if (not coalesce(v_has_cat, false) and coalesce(v_classes, 0) + 1 >= v_limit)
           or v_peak = s.rp_groups_block_sport - 1 then
          v_status := 'limited';
        else
          v_status := 'open';
        end if;
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'blocked', 'past_date') then
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
  -- rp_last_start_time (通常の最終受付) を過ぎた枠も rp_late_limit_time までは
  -- 「要相談」として出す (仕様 3: 17:00 以降は要相談)。
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
    'weather', jsonb_build_object(
      'status',  coalesce(v_weather.weather_status, 'normal'),
      'message', v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
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

-- -----------------------------------------------------------------------------
-- 月表示用のダイジェスト (管理カレンダー / 公開スケジュール)
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
      'weather', st->'weather'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
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
