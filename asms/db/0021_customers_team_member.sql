-- =========================================================================
-- 0021_customers_team_member.sql
-- -------------------------------------------------------------------------
-- 顧客カルテに「チーム加入日」を追加。リピート funnel の最終段階として使う:
--   体験のみ → リピート → チャレンジ (トヨピー) → Rotax → チーム加入
--
-- チーム加入は ASMS の予約とは独立した外部イベント (別途チーム側で管理
-- されている契約) なので、スタッフが手動でカルテに入力する運用。
-- 退会も想定してカラム 1 本 (加入日) を NULL 許容で持つ。将来退会日が
-- 必要になれば team_left_at 等を追加する。
-- =========================================================================

alter table customers
  add column if not exists team_member_since date;

create index if not exists idx_customers_team_member
  on customers(team_member_since)
  where team_member_since is not null;

comment on column customers.team_member_since is
  'チーム加入日 (NULL = 未加入)。売上集計のリピート funnel 最終段で参照。';
