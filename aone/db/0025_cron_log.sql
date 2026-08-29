-- =============================================================================
-- cron の実行記録
-- =============================================================================
-- 2026-08 オーナー要望:
--
--   「cron が動いているか、Cloudflare のログを見ないと分からない」
--
-- 定時実行を Cloudflare Workers Cron Triggers に移した理由は
-- 「黙って止まるのが怖い」だった。なのに動作確認が Cloudflare のログ頼みでは、
-- 止まったことに気づけない (毎日ログを見に行く人はいない)。
--
-- 1 時間に 1 行だけ残し、管理画面のトップに「最終実行」を出す。
-- 半日以上動いていなければそこに警告が出る。
--
-- ★ ここに入れるのは「いつ動いたか」だけ。1 通ごとの成否と失敗理由は
--   これまでどおり aone_mail_log に入る (2 か所に同じものを持たない)。
--
-- 量: 24 行/日 = 約 9,000 行/年。放っておいても困らないが、
--     2 年ぶんを超えたら古いものを消してよい。
-- =============================================================================

create table if not exists aone_cron_log (
  id         uuid primary key default gen_random_uuid(),
  ran_at     timestamptz not null default now(),
  -- JST での時・日 (どの回か。UTC のままだと運用の話と噛み合わない)
  hour_jst   integer not null,
  day_jst    integer not null,
  -- その回に回した仕事の数。0 = 送るものが無い時間 (深夜など)
  task_count integer not null default 0,
  -- 全部 HTTP 200 だったか
  ok         boolean not null default true,
  -- 回した中身 [{path, status, result}]。細かい話はここだけ見れば分かる
  detail     jsonb not null default '[]'::jsonb
);

comment on table aone_cron_log is
  'cron が動いた記録。1 時間に 1 行。管理画面の「自動メール」欄が読む';

create index if not exists aone_cron_log_ran_idx on aone_cron_log (ran_at desc);

alter table aone_cron_log enable row level security;
-- ポリシーを作らない = anon からは見えない (service_role だけが読み書きする)

-- ⚠ 0005 の `grant all on all tables in schema public to service_role` は
--   その時点で存在したテーブルにしか効かない。あとから足したテーブルには
--   個別に grant が要る (0022 で実際に踏んだ)。
grant all on aone_cron_log to service_role;

-- -----------------------------------------------------------------------------
-- 管理画面に出す 1 行ぶん
-- -----------------------------------------------------------------------------
-- 「最後にいつ動いたか」「その回で何通送ったか」を 1 回の問い合わせで返す。
-- 画面側で集計すると、画面が増えるたびに同じ集計を書くことになる。
create or replace function aone_cron_health()
returns jsonb
language sql stable as $$
  with last as (
    select * from aone_cron_log order by ran_at desc limit 1
  ),
  today_mails as (
    select count(*) filter (where ok) as sent,
           count(*) filter (where not ok) as failed
    from aone_mail_log
    where created_at >= (aone_today()::timestamptz - interval '9 hours')
      and kind in ('reminder', 'thanks', 'followup')
  )
  select jsonb_build_object(
    'last_run_at',  (select ran_at from last),
    'last_hour_jst',(select hour_jst from last),
    'last_ok',      (select ok from last),
    'last_tasks',   (select task_count from last),
    'last_detail',  (select detail from last),
    -- 動いていれば 1 時間に 1 回は入る。90 分以上あいていたら止まっている疑い
    'stale',        coalesce(
                      (select ran_at from last) < now() - interval '90 minutes',
                      true),
    'mails_today',  (select sent from today_mails),
    'mails_failed_today', (select failed from today_mails)
  );
$$;

comment on function aone_cron_health() is
  'cron が動いているかの 1 行サマリ。管理トップの「自動メール」欄が使う';

grant execute on function aone_cron_health() to service_role;
