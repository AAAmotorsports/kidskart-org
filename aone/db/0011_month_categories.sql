-- =============================================================================
-- 月カレンダーにカテゴリー別の走行可否を持たせる
-- =============================================================================
-- 「前 ○ / 後 ○」だけでは、カートが走れるのかミニバイクが走れるのかが
-- 利用者に分からなかった。月表示にもカテゴリーごとの状態を持たせて、
-- 「前 カート・ミニバイク」のように何が走れるかを出せるようにする。
--
-- 返すのは集計だけ。予約者名は公開カレンダーには一切出さない。
-- =============================================================================

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
