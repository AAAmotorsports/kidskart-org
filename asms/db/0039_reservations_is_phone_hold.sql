-- 0039: reservations.is_phone_hold
--
-- 電話予約の一時ホールドフラグ。
-- 「電話で名前・人数・会員区別だけ受けて席を確保 → 当日受付で本人が iPad で
-- 詳細記入」の 2 段階フロー用。
--
-- 挙動:
--   is_phone_hold=TRUE の予約は:
--     - 席は確保する (participant 行は placeholder 名で作成する)
--     - 顧客確認メール・サンキュー・リマインド・フォローアップ cron は skip
--       (placeholder email を使うので既存の @noemail.local 判定で既に skip される)
--     - カルテ・サンキュー等の表示では「電話予約 (iPad 記入待ち)」バッジ
--   iPad で詳細記入が完了したら is_phone_hold=FALSE に更新。
--
-- 既存の予約は全て FALSE (= 通常予約) になる。NOT NULL + DEFAULT FALSE。
--
-- 実行:
--   アプリ deploy の前・後どちらでも可 (新カラムはアプリが未使用時 default)。
--   rollback: ALTER TABLE reservations DROP COLUMN is_phone_hold;

ALTER TABLE reservations
  ADD COLUMN is_phone_hold BOOLEAN NOT NULL DEFAULT FALSE;

-- 電話予約一覧の検索を速くする (管理画面で未完成分を抽出する想定)。
CREATE INDEX idx_reservations_is_phone_hold
  ON reservations(is_phone_hold)
  WHERE is_phone_hold = TRUE;
