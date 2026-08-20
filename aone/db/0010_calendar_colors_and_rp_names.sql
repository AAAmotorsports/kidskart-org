-- =============================================================================
-- カテゴリーの色分け と RP 予約者名の公開設定
-- =============================================================================
-- 1. 管理カレンダーでスポーツ走行をカテゴリー別に色分けするための色を持たせる。
--    将来ポケバイ・モタード等を足しても、色をここで決めれば画面に反映される。
--
-- 2. 予約画面 (顧客向け RP) に「すでに入っている予約の時間と名前」を出す。
--    旧スケジュールページ (WordPress) が「AM10:00〜 RP パットリ様」と
--    実名を公開していた運用に合わせる。ただし公開範囲は選べるようにする:
--      full   … 入力されたお名前をそのまま (山田太郎 様)
--      family … 姓だけ (山田 様)   ← 既定
--      hidden … 名前は出さず時間だけ
--    スタッフ向けの管理画面は従来どおりフルネームを表示する。
-- =============================================================================

alter table aone_categories
  add column if not exists color text not null default '#6d8095';

comment on column aone_categories.color is '管理カレンダーでの表示色 (CSS カラー)';

update aone_categories set color = '#0f8a8a' where code = 'kart';      -- 青緑
update aone_categories set color = '#1e9e62' where code = 'minibike';  -- 緑
update aone_categories set color = '#f5a623' where code = 'kidskart';  -- オレンジ
update aone_categories set color = '#6d8095' where code = 'other';     -- グレー

alter table aone_settings
  add column if not exists public_name_display text not null default 'family';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'aone_settings_public_name_display_chk'
  ) then
    alter table aone_settings
      add constraint aone_settings_public_name_display_chk
      check (public_name_display in ('full', 'family', 'hidden'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 公開用の表示名
-- -----------------------------------------------------------------------------
-- 「山田 太郎」→「山田」、空白が無い「山田太郎」→ 先頭 2 文字「山田」。
-- 日本語の姓は 2 文字が最も多いので既定はこれ。3 文字姓 (佐々木 等) は
-- 「佐々様」になってしまうため、正確さが要るなら full を選ぶ運用にする。
create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  select case
    when p_mode = 'hidden' then null
    when p_mode = 'full'   then trim(p_name) || ' 様'
    when position(' ' in trim(p_name)) > 0 or position('　' in trim(p_name)) > 0
      then split_part(replace(trim(p_name), '　', ' '), ' ', 1) || ' 様'
    when length(trim(p_name)) <= 3 then trim(p_name) || ' 様'
    else left(trim(p_name), 2) || ' 様'
  end;
$$;

-- -----------------------------------------------------------------------------
-- ある日の RP 予約一覧 (公開用)
-- -----------------------------------------------------------------------------
-- 返すのは開始時間・人数・表示名だけ。電話番号やメールは絶対に返さない。
create or replace function aone_rp_day_bookings(p_date date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'time', to_char(r.start_time, 'HH24:MI'),
           'party_size', r.party_size,
           'name', aone_public_name(r.contact_name, s.public_name_display),
           'status', r.status
         ) order by r.start_time), '[]'::jsonb)
  from aone_reservations r, aone_settings s
  where s.id = 1
    and r.date = p_date
    and r.kind = 'rp'
    and aone_is_live(r.status);
$$;

grant execute on function aone_rp_day_bookings(date) to anon, authenticated, service_role;
grant execute on function aone_public_name(text, text) to anon, authenticated, service_role;
