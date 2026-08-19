-- =============================================================================
-- A-ONE 予約システム — RLS と権限
-- =============================================================================
-- 方針 (ASMS と同じ):
--   * 公開 API (anon key) から読めるのは「非機微データ」だけ
--       カテゴリー / 設定 / 営業日ステータス / 公開ブロック / 祝日
--   * 予約・顧客テーブルは anon から一切読めない (PII)
--   * 空き状況は SECURITY DEFINER 関数で「集計結果だけ」返す
--       → 誰が何時に予約したかは漏れない
--   * 書き込み系 RPC は service_role のみ (Astro の API ルートから呼ぶ)
-- =============================================================================

alter table aone_settings       enable row level security;
alter table aone_categories     enable row level security;
alter table aone_holidays       enable row level security;
alter table aone_business_days  enable row level security;
alter table aone_blocks         enable row level security;
alter table aone_customers      enable row level security;
alter table aone_reservations   enable row level security;
alter table aone_reservation_events enable row level security;
alter table aone_mail_log       enable row level security;
alter table aone_broadcasts     enable row level security;

-- ---- 公開読み取り -----------------------------------------------------------
drop policy if exists aone_pub_read_settings on aone_settings;
create policy aone_pub_read_settings on aone_settings for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_categories on aone_categories;
create policy aone_pub_read_categories on aone_categories for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_holidays on aone_holidays;
create policy aone_pub_read_holidays on aone_holidays for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_days on aone_business_days;
create policy aone_pub_read_days on aone_business_days for select to anon, authenticated using (true);

-- 公開フラグの立ったブロックのみ (社内メモ付きの非公開予定は隠す)
drop policy if exists aone_pub_read_blocks on aone_blocks;
create policy aone_pub_read_blocks on aone_blocks for select to anon, authenticated using (is_public);

-- 予約 / 顧客 / 監査 / メールログには anon 用ポリシーを作らない (= 読めない)

grant usage on schema public to anon, authenticated;
grant select on aone_settings, aone_categories, aone_holidays, aone_business_days, aone_blocks
  to anon, authenticated;

-- service_role はすべて (RLS はバイパスされる)
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---- 空き状況関数: SECURITY DEFINER で集計だけ公開 ---------------------------
alter function aone_day_state(date)                     security definer set search_path = public, pg_temp;
alter function aone_month_state(integer, integer)       security definer set search_path = public, pg_temp;
alter function aone_check_availability(text, date, text, text, time, time, integer, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_rp_peak_groups(date, time, time, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_live_reservations_in_window(date, time, time, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_blocking_blocks(date, text, text, time, time)
                                                        security definer set search_path = public, pg_temp;

revoke all on function aone_live_reservations_in_window(date, time, time, uuid) from public, anon, authenticated;
revoke all on function aone_rp_peak_groups(date, time, time, uuid) from public, anon, authenticated;

grant execute on function aone_day_state(date) to anon, authenticated, service_role;
grant execute on function aone_month_state(integer, integer) to anon, authenticated, service_role;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid)
  to anon, authenticated, service_role;
grant execute on function aone_is_holiday(date) to anon, authenticated, service_role;
grant execute on function aone_today() to anon, authenticated, service_role;

-- ---- 書き込み RPC: service_role 専用 ----------------------------------------
revoke all on function aone_create_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_update_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_cancel_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_set_reservation_status(jsonb) from public, anon, authenticated;
revoke all on function aone_upsert_customer(text, text, text, text) from public, anon, authenticated;

grant execute on function aone_create_reservation(jsonb)     to service_role;
grant execute on function aone_update_reservation(jsonb)     to service_role;
grant execute on function aone_cancel_reservation(jsonb)     to service_role;
grant execute on function aone_set_reservation_status(jsonb) to service_role;
grant execute on function aone_upsert_customer(text, text, text, text) to service_role;

-- 顧客サマリ VIEW も service_role のみ
revoke all on aone_customer_stats from public, anon, authenticated;
grant select on aone_customer_stats to service_role;
