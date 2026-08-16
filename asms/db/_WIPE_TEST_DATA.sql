-- =========================================================================
-- _WIPE_TEST_DATA.sql — テストデータ全消去 (⚠️ 本番運用開始前だけ使用)
-- -------------------------------------------------------------------------
-- 顧客・予約・売上関連の全データを白紙に戻す。
--
-- 消す:
--   consents               ← 電子署名・同意記録
--   reservation_participants ← 予約参加者
--   reservations           ← 予約 + 支払い記録 (paid_at 等)
--   customer_progressions  ← 習熟度履歴
--   customer_bests         ← ベストタイム
--   guardian_customer_links ← 保護者↔子供リンク
--   customers              ← 顧客カルテ
--   guardians              ← 保護者
--
-- 消さない (構造・設定は維持):
--   courses / terms / slots / schedule_rules / schedule_exceptions
--   auth.users (Magic Link サインイン済みユーザー)
--
-- FK 制約の順序を守って DELETE。トランザクションで包み、途中失敗したら
-- 全ロールバック。
-- =========================================================================

begin;

-- FK 依存順:
-- consents               → reservations
-- customer_progressions  → reservation_participants, customers  ← rp より先
-- customer_bests         → customers
-- reservation_participants → reservations, customers
-- reservations           → slots, guardians
-- guardian_customer_links → guardians, customers
-- customers, guardians   → (葉)

delete from consents;
delete from customer_progressions;
delete from customer_bests;
delete from reservation_participants;
delete from reservations;
delete from guardian_customer_links;
delete from customers;
delete from guardians;

-- reservation_number の連番があれば reset (基本 date-based なので不要)
-- customer_number は関数生成なので reset 不要

-- 確認クエリ (全部 0 になっているはず)
select
  (select count(*) from consents)               as consents,
  (select count(*) from reservation_participants) as res_parts,
  (select count(*) from reservations)           as reservations,
  (select count(*) from customer_progressions)  as progressions,
  (select count(*) from customer_bests)         as bests,
  (select count(*) from guardian_customer_links) as links,
  (select count(*) from customers)              as customers,
  (select count(*) from guardians)              as guardians;

commit;
