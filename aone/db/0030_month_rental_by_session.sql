-- =============================================================================
-- 月のスケジュールに「午前/午後どちらでレンタルカートが走れるか」を持たせる
-- =============================================================================
-- 「レンタルカート ○」を 1 日単位で出していたため、午前だけレースで埋まっている
-- 日でも終日 ○ に見えていた (2026-09 オーナー指摘: 13 日は午前 ✕・午後 ○)。
--
-- 走れるかどうかは、その時間帯のレースパックの枠が生きているかで見る。
-- 終日のレース・臨時休業・走行中止のときは枠が全部止まるので、自然に ✕ になる。
-- 12:00 開始からを午後とするのは、公開スケジュールの RP・貸切の並べ方と同じ。
-- =============================================================================

create or replace function aone_month_state(p_year integer, p_month integer)
returns jsonb
language sql stable as $$
  with days as (
    select generate_series(
      make_date(p_year, p_month, 1),
      (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
      '1 day'
    )::date as d
  ),
  -- materialized が要る。付けないと CTE がインライン展開され、
  -- st を参照するたびに aone_day_state() が呼ばれて 1 か月ぶんで数十秒かかる
  states as materialized (
    select d, aone_day_state(d) as st from days
  )
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'),
      'dow', extract(dow from d)::int,
      'is_holiday', (st->>'is_holiday')::boolean,
      'business', st->'business'->>'status',
      'surface', st->'surface'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
      'am_categories', st->'sport'->'am'->'categories',
      'pm_categories', st->'sport'->'pm'->'categories',
      'rp_free', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                   where (s->>'accepting')::boolean),
      -- 午前 / 午後それぞれで、レンタルカートが走れるか。
      -- ★ コースが開いている時間の枠だけ数える。閉まったあとの枠 (17:30〜) は
      --    「要相談」で受付可のまま残るので、これを数えると午後を止めた日でも
      --    「走れる」に見えてしまう
      'rp_free_am', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                      where (s->>'accepting')::boolean
                        and (s->>'time')::time >= (st->'hours'->>'course_open')::time
                        and (s->>'time')::time < '12:00'),
      'rp_free_pm', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                      where (s->>'accepting')::boolean
                        and (s->>'time')::time >= '12:00'
                        and (s->>'time')::time < (st->'hours'->>'course_close')::time),
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
