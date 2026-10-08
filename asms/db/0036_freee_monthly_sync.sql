-- 0036_freee_monthly_sync.sql
--
-- ASMS → freee 月次売上同期の状態を記録する 2 テーブル。
--
-- 【monthly_freee_sync】
--   毎月 1 日 10:00 JST に Cloudflare Worker Cron が前月分の reservations を
--   支払い方法で集計し、freee に 2 件の deal (現金 / PayPay) を作成する。
--   この表はその結果を 1 月 1 行で記録し、
--     - 冪等性 (同じ月を 2 度 push しない)
--     - admin/sales ページでの「freee 送信済」バッジ表示
--     - 失敗時のリトライ対象の特定
--   の 3 目的で使う。
--
--   ym は 'YYYY-MM' 形式。
--   cash_deal_id / paypay_deal_id は freee の deal.id (null は未送信 or 対象 0 円)。
--   クレカ・その他は自動 sync 対象外のため、金額のみ参考に保持する
--   (ASMS で非 0 なら admin UI で手動対応を促すバッジを出す)。
--
-- 【freee_oauth_state】
--   freee OAuth の refresh_token は 1 回使うとローテートされ、
--   「次回に有効な値」が返ってくる。
--   Cloudflare Secret は Worker から書き換えられないので、ローテ後の
--   最新値を DB に保存して次回取得時に優先的に使う。
--   初回 (DB 未保存時) は Worker Secret `FREEE_REFRESH_TOKEN` を使い、
--   成功後にその返却値で DB を更新する。
--   DB の値が invalid_grant になった時は Secret にフォールバックする
--   (invoice-system/scripts/freee-sync.js と同じローテ戦略)。
--
-- 本 SQL の実行は アプリ deploy の 前/後 どちらでも可。
-- (アプリ側は存在しないテーブルを参照しても graceful に扱う設計)

create table if not exists monthly_freee_sync (
  ym               text        primary key check (ym ~ '^\d{4}-\d{2}$'),

  -- 現金売上
  cash_amount      integer     not null default 0 check (cash_amount >= 0),
  cash_count       integer     not null default 0 check (cash_count >= 0),
  cash_deal_id     bigint,       -- freee の deal.id (null = 未送信 or 0 円)

  -- PayPay 売上
  paypay_amount    integer     not null default 0 check (paypay_amount >= 0),
  paypay_count     integer     not null default 0 check (paypay_count >= 0),
  paypay_deal_id   bigint,

  -- 自動 sync 対象外 (参考値; 非 0 なら admin UI でバッジ)
  credit_amount    integer     not null default 0 check (credit_amount >= 0),
  credit_count     integer     not null default 0 check (credit_count >= 0),
  other_amount     integer     not null default 0 check (other_amount >= 0),
  other_count      integer     not null default 0 check (other_count >= 0),

  -- 同期の実行結果
  status           text        not null default 'pending'
    check (status in ('pending', 'success', 'partial', 'error')),
  error_message    text,
  synced_at        timestamptz,
  attempted_count  integer     not null default 0,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table  monthly_freee_sync is
  'ASMS → freee 月次売上同期の状態 (ym=YYYY-MM で 1 月 1 行)。';
comment on column monthly_freee_sync.status is
  'pending=未送信, success=両方送信済, partial=片方だけ成功, error=両方失敗。';
comment on column monthly_freee_sync.cash_deal_id is
  'freee の deal.id。null は未送信 or 当月 0 円で deal 不要。';

create index if not exists idx_monthly_freee_sync_status
  on monthly_freee_sync(status)
  where status != 'success';

-- updated_at 自動更新トリガ (他テーブルで既に使っている関数を再利用、
-- 無ければシンプルに自前で生やす)
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'set_updated_at') then
    create function set_updated_at() returns trigger as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$ language plpgsql;
  end if;
end$$;

drop trigger if exists monthly_freee_sync_set_updated_at on monthly_freee_sync;
create trigger monthly_freee_sync_set_updated_at
  before update on monthly_freee_sync
  for each row execute function set_updated_at();


-- =============================================================================
create table if not exists freee_oauth_state (
  -- 固定キー。freee アカウントは 1 つしか無いので single-row テーブル。
  -- (将来複数会計事務所 or 複数会社に対応する時は company_id を key に昇格。)
  singleton        boolean     primary key default true check (singleton),

  refresh_token    text,
  updated_at       timestamptz not null default now(),
  invalidated_at   timestamptz,   -- invalid_grant 検知時刻 (この後 Secret へフォールバック)

  constraint freee_oauth_state_singleton check (singleton)
);

comment on table  freee_oauth_state is
  'freee OAuth の最新 refresh_token。ローテーション後の値を保持する。';
comment on column freee_oauth_state.refresh_token is
  'null なら Worker Secret FREEE_REFRESH_TOKEN を使う (初期 or invalidated 後)。';
