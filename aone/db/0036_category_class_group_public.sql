-- =============================================================================
-- 公開面では「まとめ先のカテゴリー」だけを出せるようにする
-- =============================================================================
-- 2026-11 オーナー指示:
--   「表示はカートだけでいい。GR カートはホームページ上には載せなくていい。
--     こっちがお客さんが GR カートで予約したっていうのを知りたいだけだから」
--
-- * **予約フォームには GR カートを出したまま**にする。お客様が選んでくれないと
--   「GR カートで来る」ことが分からない (これが足した理由そのもの)
-- * **空き状況の表示 (今日走れる？ / スケジュール / 貼り付けウィジェット) には
--   出さない。** GR カートはカートと同じ枠なので、○ が 2 つ並んでも
--   お客様には同じことしか伝わらない
--
-- やることは 1 つだけ: aone_day_state() が返すカテゴリーに class_group を足す。
-- 畳む (GR カート → カート) のはアプリ側 (foldCategories)。
-- ★ 中身は 0035 と同じ。足したのは class_group の 1 行だけ
-- =============================================================================

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

    -- クラス数は「枠」で数える。GR カートはカートと同じ枠なので、
    -- 2 つ入っていても 1 クラス (0035)
    select count(distinct aone_class_group(r.category_code)) into v_classes
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
        -- 同じ枠にまとめてある先のカテゴリー code (null = 単独)。
        -- 公開面はこれを見て代表のカテゴリーに畳む — GR カートは
        -- 「カート」として出す (2026-11 オーナー指示。0036)
        'class_group', v_cat.class_group,
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
