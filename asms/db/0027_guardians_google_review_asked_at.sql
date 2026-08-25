-- =========================================================================
-- 0027_guardians_google_review_asked_at.sql
-- -------------------------------------------------------------------------
-- guardians.google_review_asked_at を追加。
-- サンキューメールで Google 口コミ CTA を送ったタイムスタンプを記録する。
--
-- 運用:
--   - NULL   = まだ口コミ依頼を送っていない → 次の初回参加時に送る候補
--   - NOT NULL = 一度送った → 二度と自動送信しない (保護者単位で 1 回だけ)
--
-- 「初回参加後のみ」判定は cron 側で「その保護者の過去参加数 == 0」を
-- チェックして行う。ここは単に「送ったかどうか」の履歴フラグ。
-- =========================================================================

alter table guardians
  add column if not exists google_review_asked_at timestamptz null;

comment on column guardians.google_review_asked_at is
  'Timestamp when a Google review CTA was sent in the thankyou email. NULL = never asked. Set once per guardian and never overwritten (see /api/cron/thankyou-mail).';
