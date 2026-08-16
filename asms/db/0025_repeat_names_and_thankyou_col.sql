-- =========================================================================
-- 0025_repeat_names_and_thankyou_col.sql
-- -------------------------------------------------------------------------
-- 2 件まとめて:
--   1. リピート練習の表示名を「実走行時間」に揃える
--        repeat_60 (実 50 分) → 「リピート練習 50分」
--        repeat_30 (実 25 分) → 「リピート練習 25分」
--      ※ code は内部 ID なので触らない (既存予約への影響なし)
--
--   2. reservations.thankyou_email_sent_at カラム追加
--      → 予約当日 18:00 の自動サンキューメールで、二重送信防止
-- =========================================================================

begin;

-- 1. コース表示名の修正
update courses set name = 'リピート練習 50分' where code = 'repeat_60';
update courses set name = 'リピート練習 25分' where code = 'repeat_30';

-- 2. サンキューメール送信済みタイムスタンプ
alter table reservations
  add column if not exists thankyou_email_sent_at timestamptz;

comment on column reservations.thankyou_email_sent_at is
  '予約当日 18:00 の自動サンキューメールを送信した時刻。null なら未送信。二重送信防止用。';

-- 確認
select code, name, duration_min from courses
  where code in ('repeat_30', 'repeat_60')
  order by code;

commit;
