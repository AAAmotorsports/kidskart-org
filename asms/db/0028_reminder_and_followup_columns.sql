-- =========================================================================
-- 0028_reminder_and_followup_columns.sql
-- -------------------------------------------------------------------------
-- reservations に 2 個のタイムスタンプ列を追加。
--
--   reminder_email_sent_at   前日リマインドメール送信済み印
--     - /api/cron/reminder-mail が発火時に更新
--     - 毎日 18:00 JST の cron。重複送信を防ぐ
--
--   followup_email_sent_at   1 ヶ月後フォローアップメール送信済み印
--     - /api/cron/followup-mail が発火時に更新
--     - 毎日 19:00 JST の cron。「30 日以上再予約なし」保護者に 1 回だけ
--     - 一度送ったら永久に再送しない
-- =========================================================================

alter table reservations
  add column if not exists reminder_email_sent_at timestamptz null,
  add column if not exists followup_email_sent_at timestamptz null;

comment on column reservations.reminder_email_sent_at is
  '前日リマインドメール送信タイムスタンプ。/api/cron/reminder-mail が更新。NULL = 未送信。';
comment on column reservations.followup_email_sent_at is
  '1ヶ月後フォローアップメール送信タイムスタンプ。/api/cron/followup-mail が更新。NULL = 未送信。保護者単位で一度きり。';
