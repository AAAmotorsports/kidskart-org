-- =========================================================================
-- 0029_cron_runs.sql
-- -------------------------------------------------------------------------
-- Cloudflare Workers Cron Triggers の実行履歴を DB に残して、管理画面
-- から「最後にいつ動いたか」「送信件数」「エラーの有無」を可視化する。
--
-- 目的:
--   1. 「無音で死ぬ」を防ぐ (半日以上動いてなければ管理画面で赤バッジ)
--   2. 送信件数・失敗件数を運用者が Cloudflare Logs を開かずに確認可能
--   3. 事故の原因調査 (何時に何が起きたか) のための observability
--
-- 使い方:
--   /api/cron/*.ts から logCronRun() ヘルパー経由で 1 実行 = 1 行 insert。
--   /admin ダッシュボードで最新行と直近履歴を表示。
--
-- 保存量:
--   3 cron × 1 実行/日 = 3 行/日 = ~1,100 行/年。数年放置しても軽量。
--   古いデータは要らなくなったら手動 delete で足りる (自動 lifecycle 不要)。
-- =========================================================================

create table if not exists cron_runs (
  id              uuid primary key default uuid_generate_v4(),
  cron_name       text not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',   -- 'running' | 'success' | 'error'
  summary         jsonb,                              -- {total, sent, skipped, failed, ...}
  error_message   text,
  duration_ms     integer
);

create index if not exists idx_cron_runs_name_time
  on cron_runs (cron_name, started_at desc);

comment on table cron_runs is
  'Cloudflare Workers Cron Triggers の実行履歴。管理画面で "自動メールの動作状況" を可視化するためのソース。';

comment on column cron_runs.cron_name is
  'thankyou-mail / reminder-mail / followup-mail などの識別子。';
comment on column cron_runs.status is
  'running (開始直後), success (正常終了・送信 0 件も含む), error (例外発生) の 3 値。';
comment on column cron_runs.summary is
  '成功時に API が返す JSON をそのまま入れる。UI で total / sent / skipped / failed を抽出して表示。';

-- 認証済みユーザー (staff) は全ての cron_runs を読み書きできる
alter table cron_runs enable row level security;
create policy staff_all_cron_runs on cron_runs
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
-- service_role (Cloudflare Workers) は RLS を bypass するので直接 CRUD 可能。
