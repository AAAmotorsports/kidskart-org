-- =============================================================================
-- 公開カレンダーに RP・貸切の予約 (時間 + 名前) を出す
-- =============================================================================
-- 旧 WordPress スケジュールが「AM10:00〜 RP パットリ様」「貸切午前」と
-- 出していた運用に合わせる。公開するのは
--   種別 (RP / 貸切) ・時間・人数・表示名
-- だけで、電話番号やメールは返さない。
--
-- 名前の粒度は aone_settings.public_name_display で切り替える
-- (family: 姓のみ / full: 入力どおり / hidden: 名前を出さない)。
-- hidden にすれば「10:00 RP 5名」のように名前なしで出る。
--
-- あわせて敬称の二重付けを直す。スタッフが「クオ様」と入力した予約が
-- 「クオ様 様」と表示されていた。
-- =============================================================================

-- 末尾の敬称を落とす (様 / さま / サマ / さん / 御中)
create or replace function aone_strip_honorific(p_name text) returns text
language sql immutable as $$
  select nullif(trim(regexp_replace(trim(coalesce(p_name, '')),
    '(様|さま|サマ|さん|サン|御中)\s*$', '')), '');
$$;

create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  with n as (select coalesce(aone_strip_honorific(p_name), trim(coalesce(p_name, ''))) as v)
  select case
    when p_mode = 'hidden' then null
    when (select v from n) = '' then null
    when p_mode = 'full' then (select v from n) || ' 様'
    when position(' ' in (select v from n)) > 0 or position('　' in (select v from n)) > 0
      then split_part(replace((select v from n), '　', ' '), ' ', 1) || ' 様'
    when length((select v from n)) <= 3 then (select v from n) || ' 様'
    else left((select v from n), 2) || ' 様'
  end;
$$;

-- -----------------------------------------------------------------------------
-- 期間内の RP・貸切の予約 (公開用)
-- -----------------------------------------------------------------------------
-- 日付をキーにした jsonb オブジェクトで返す: { "2026-09-02": [ {...}, ... ] }
create or replace function aone_rental_bookings(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(d, items), '{}'::jsonb)
  from (
    select to_char(r.date, 'YYYY-MM-DD') as d,
           jsonb_agg(jsonb_build_object(
             'kind', r.kind,
             'time', to_char(r.start_time, 'HH24:MI'),
             'end_time', to_char(r.end_time, 'HH24:MI'),
             'party_size', r.party_size,
             -- 貸切は団体名が入るので略さない (「麻生工科大学」→「麻生」では困る)。
             -- 名前を出さない設定のときだけ null にする。
             'name', case
               when r.kind = 'charter'
                 then aone_public_name(r.contact_name,
                        case when s.public_name_display = 'hidden' then 'hidden' else 'full' end)
               else aone_public_name(r.contact_name, s.public_name_display)
             end
           ) order by r.start_time) as items
    from aone_reservations r, aone_settings s
    where s.id = 1
      and r.date between p_from and p_to
      and r.kind in ('rp', 'charter')
      and aone_is_live(r.status)
    group by r.date
  ) t;
$$;

grant execute on function aone_rental_bookings(date, date) to anon, authenticated, service_role;
grant execute on function aone_strip_honorific(text) to anon, authenticated, service_role;
