-- 0013_add_payment_tracking.sql
--
-- 会計管理: 予約ごとに支払い方法・支払い日時・支払い額を記録する。
--
-- ・payment_method は現金 / PayPay / クレカ / その他 の 4 種類。
-- ・paid_amount は total_amount と別カラムで持つ (会員価格の失念、
--   小銭対応、当日追加購入などで乖離するケースがあるため)。
-- ・NULL 許容 = まだ会計していない状態を表す。
-- ・月次集計は paid_at のインデックスで高速化。

alter table reservations
  add column if not exists payment_method text
    check (payment_method in ('cash', 'paypay', 'credit', 'other')),
  add column if not exists paid_at        timestamptz,
  add column if not exists paid_amount    integer check (paid_amount >= 0),
  add column if not exists payment_note   text;

create index if not exists idx_reservations_paid_at
  on reservations(paid_at)
  where paid_at is not null;

create index if not exists idx_reservations_payment_method
  on reservations(payment_method)
  where payment_method is not null;

comment on column reservations.payment_method is
  '支払い方法: cash | paypay | credit | other。NULL = 未会計。';
comment on column reservations.paid_at is
  '会計完了日時。月次集計の基準日として使用。';
comment on column reservations.paid_amount is
  '実際に受領した金額。total_amount と別管理 (会員価格失念/端数調整/当日追加等)。';
comment on column reservations.payment_note is
  '会計備考 (領収書番号、割引理由など)。';
