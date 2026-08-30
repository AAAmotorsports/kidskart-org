-- =========================================================================
-- 0031_customers_pre_asms_history.sql
-- -------------------------------------------------------------------------
-- customers に「ASMS 移行前 (エアレジ時代) の参加履歴」情報を持たせる。
--
-- 目的:
--   ASMS 導入前にエアレジで受付していたリピーターについて、初回来店日と
--   累計走行回数だけを手動で入力できるようにする。当時の日別トランザク
--   ションは残ってないので、カルテ画面で「エアレジ時代 (初回 2023-05-14
--   · 5 回)」というサマリーだけを表示する運用にする。
--
--   ASMS 導入後の予約・参加は reservation_participants に記録される
--   ので、「エアレジ時代 + ASMS 移行後」の合算を見せることで
--   「累計何回来た子か」がスタッフから見えるようになる。
--
-- カラム:
--   pre_asms_first_visit_date  DATE     初回来店日 (エアレジ時代)
--   pre_asms_visit_count       INTEGER  移行前累計走行回数 (0 or NULL 許容)
--
-- NULL 許容: エアレジ時代の情報がない = ASMS 導入以降の新規顧客
-- =========================================================================

alter table customers
  add column if not exists pre_asms_first_visit_date date null,
  add column if not exists pre_asms_visit_count integer null
    check (pre_asms_visit_count is null or pre_asms_visit_count >= 0);

comment on column customers.pre_asms_first_visit_date is
  'ASMS 移行前 (エアレジ時代) の初回来店日。NULL は ASMS 導入以降の新規顧客。';
comment on column customers.pre_asms_visit_count is
  'ASMS 移行前 (エアレジ時代) の累計走行回数。NULL または 0 は該当なし。';
