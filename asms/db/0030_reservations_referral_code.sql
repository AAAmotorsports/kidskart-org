-- =========================================================================
-- 0030_reservations_referral_code.sql
-- -------------------------------------------------------------------------
-- reservations に referral_code カラムを追加。
--
-- 目的:
--   予約フローの入口 URL に付いた ?ref=xxx パラメータをサーバー側で拾って
--   保存し、後から「どの経路経由の予約か」を集計できるようにする。
--
--   使用例:
--     - QR コード / AUTOPOLIS チラシ → reserve.kidskart.org/reserve/?ref=autopolis
--     - 福岡トヨペットの紹介         → ?ref=fukuoka_toyopet
--     - Instagram プロフィール       → ?ref=ig
--
--   お客様に「参照コードを手入力」させる方式だと必ず入力忘れが出るので、
--   QR / URL 側で自動付与する運用にする。
--
-- 使い方:
--   1. QR に「?ref=autopolis」付きの URL を印字
--   2. お客様が URL を踏むと reserve/ の JS が localStorage に保存
--   3. 予約完了時に /api/reserve/create の payload に含まれ、この列に保存
--   4. /admin/reservations で該当予約に referral バッジ表示
--   5. /admin/sales で referral 別集計 (将来)
--
-- NULL 許容: 直接ドメインを打った予約や、参照元指定なしの予約は NULL のまま。
-- =========================================================================

alter table reservations
  add column if not exists referral_code text null;

comment on column reservations.referral_code is
  '予約時の参照元コード (?ref=xxx で受け取り、predefined + free-form 両対応)。NULL は参照元指定なし。';

-- 集計向けインデックス (集計クエリの WHERE referral_code = ... で使われる想定)
create index if not exists idx_reservations_referral
  on reservations (referral_code) where referral_code is not null;
