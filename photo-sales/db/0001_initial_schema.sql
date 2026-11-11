-- =============================================================================
-- A-ONE 走行写真販売 — 初期スキーマ (Supabase 新規プロジェクト用)
-- =============================================================================
-- 既存の aone 予約システムとは **別の Supabase プロジェクト**。テーブルは共有しない。
--
-- 設計の芯 (CLAUDE.md にも書いてある):
--   * 公開してよいか (同意) の判定は SQL の 1 か所 (groups.online_ok / tv_ok) だけ
--   * 価格計算も SQL の 1 か所 (photo_calc_price)
--   * 二重購入は DB の一意制約で止める (order_items.counted)
--   * すべてのテーブルは RLS 有効・anon/authenticated 用ポリシー無し。
--     アクセスは Worker (service_role) 経由のみ
-- =============================================================================

create extension if not exists pgcrypto;

-- ---- 共通ヘルパー -----------------------------------------------------------
create or replace function photo_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Tokyo')::date $$;

-- 推測困難なトークン (128bit, URL-safe base64, 22 文字)
create or replace function photo_new_token() returns text
language sql volatile as $$
  select translate(rtrim(encode(gen_random_bytes(16), 'base64'), '='), '+/', '-_')
$$;

-- ---- スタッフ ---------------------------------------------------------------
create table if not exists staff_users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,                      -- Supabase Auth の user id
  email         text not null unique,
  name          text not null,
  role          text not null default 'staff' check (role in ('admin','staff')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---- 設定 (価格・保存期間・TV) ----------------------------------------------
create table if not exists settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references staff_users(id)
);

insert into settings(key, value) values
  ('prices',    '{"single":500,"set3":1000,"pack":2000}'),
  ('retention', '{"view_days":30,"purchased_days":30,"purchased_max_days":60,"order_years":7}'),
  ('tv',        '{"slide_seconds":6,"group_seconds":60}')
on conflict (key) do nothing;

create or replace function photo_setting_int(p_key text, p_field text) returns integer
language sql stable as $$
  select (value ->> p_field)::int from settings where key = p_key
$$;

-- ---- グループ (団体・走行パック) ---------------------------------------------
create table if not exists groups (
  id            uuid primary key default gen_random_uuid(),
  qr_token      text not null unique default photo_new_token(),
  shoot_date    date not null default photo_today(),
  start_time    time,
  name          text,
  headcount     integer check (headcount is null or headcount between 1 and 500),
  plan          text not null default 'rental' check (plan in ('rental','race_pack','other')),

  -- 同意 (受付時に案内して取得)。3 種類を別々に持つ
  consent_shoot     boolean not null default false,  -- 写真撮影
  consent_online    boolean not null default false,  -- 販売ページ (オンライン) への掲載
  consent_tv        boolean not null default false,  -- 店内テレビ表示 (別管理)
  has_minor         boolean not null default false,  -- 未成年者を含む
  guardian_consent  boolean not null default false,  -- 保護者の同意を得た
  consent_note      text,
  consented_at      timestamptz,
  consented_by      uuid references staff_users(id),

  -- 公開してよいか。判定はここだけ (画面・API に再実装しない)
  online_ok boolean generated always as
    (consent_shoot and consent_online and (not has_minor or guardian_consent)) stored,
  tv_ok boolean generated always as
    (consent_shoot and consent_tv and (not has_minor or guardian_consent)) stored,

  status        text not null default 'preparing'
                check (status in ('preparing','published','hidden','deleted')),
  published_at  timestamptz,
  tv_priority_at timestamptz,                         -- 直近のアップロード時刻 (TV の優先順)
  created_by    uuid references staff_users(id),
  created_at    timestamptz not null default now(),

  -- 同意が無いグループは公開状態にできない (アプリのバグがあっても DB が止める)
  constraint groups_publish_needs_consent check
    (status <> 'published'
     or (consent_shoot and consent_online and (not has_minor or guardian_consent)))
);
create index if not exists groups_date_idx on groups(shoot_date desc, start_time);

-- 閲覧・販売の終了時刻 (撮影日 + view_days 日の翌 0:00 JST)
create or replace function photo_view_end(p_shoot_date date) returns timestamptz
language sql stable as $$
  select ((p_shoot_date + coalesce(photo_setting_int('retention','view_days'), 30) + 1)::timestamp)
         at time zone 'Asia/Tokyo'
$$;

-- ---- 写真 -------------------------------------------------------------------
create table if not exists photos (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid not null references groups(id) on delete cascade,
  taken_at      timestamptz,                          -- EXIF 撮影時刻 (並び替え用。無ければ登録時刻)
  sha256        text not null,                        -- 重複アップロード防止
  original_key  text not null,
  preview_key   text not null,
  thumb_key     text not null,
  width         integer,
  height        integer,
  bytes         integer,
  status        text not null default 'ready'
                check (status in ('ready','hidden','pending_delete','deleted')),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists photos_group_sha_uq
  on photos(group_id, sha256) where status <> 'deleted';
create index if not exists photos_group_order_idx
  on photos(group_id, taken_at, id) where status in ('ready','hidden');

-- ---- テレビ表示 -------------------------------------------------------------
create table if not exists tv_state (
  id             integer primary key default 1 check (id = 1),  -- 1 行だけ
  mode           text not null default 'auto' check (mode in ('auto','manual','off')),
  group_id       uuid references groups(id) on delete set null,
  slide_seconds  integer not null default 6 check (slide_seconds between 2 and 60),
  group_seconds  integer not null default 60 check (group_seconds between 10 and 600),
  tv_token       text not null default photo_new_token(),        -- TV の URL。再発行可
  updated_at     timestamptz not null default now()
);
insert into tv_state(id) values (1) on conflict do nothing;

-- ---- 注文 -------------------------------------------------------------------
create table if not exists orders (
  id                 uuid primary key default gen_random_uuid(),
  order_token        text not null unique default photo_new_token(),
  group_id           uuid not null references groups(id),
  email              text not null check (position('@' in email) > 1),
  status             text not null default 'pending'
                     check (status in ('pending','paid','failed','canceled','expired',
                                       'refunded','partially_refunded','needs_review')),
  amount_jpy         integer not null check (amount_jpy > 0),
  photo_count        integer not null check (photo_count > 0),
  pack_applied       boolean not null default false,   -- 全写真パックとして売ったか
  pricing_snapshot   jsonb not null,                   -- 注文時点の価格・内訳 (価格変更後も追える)
  stripe_session_id  text unique,
  stripe_payment_intent text,
  review_reason      text,                             -- needs_review の理由
  paid_at            timestamptz,
  download_expires_at timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists orders_group_idx  on orders(group_id);
create index if not exists orders_paid_idx   on orders(paid_at) where paid_at is not null;
create index if not exists orders_status_idx on orders(status, created_at);

create table if not exists order_items (
  id        uuid primary key default gen_random_uuid(),
  order_id  uuid not null references orders(id) on delete cascade,
  photo_id  uuid not null references photos(id),
  group_id  uuid not null references groups(id),
  -- 決済確定 (かつ返金されていない) 写真だけ true。
  -- 同じ写真で true は 1 行だけ = 二重購入を DB が止める
  counted   boolean not null default false,
  unique (order_id, photo_id)
);
create unique index if not exists order_items_photo_counted_uq
  on order_items(photo_id) where counted;

create table if not exists stripe_events (
  event_id     text primary key,                      -- Webhook の冪等性
  type         text not null,
  received_at  timestamptz not null default now()
);

create table if not exists refunds (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id),
  stripe_refund_id  text unique,
  amount_jpy        integer not null check (amount_jpy > 0),
  reason            text,
  staff_id          uuid references staff_users(id),
  created_at        timestamptz not null default now()
);

create table if not exists download_events (
  id        bigserial primary key,
  order_id  uuid not null references orders(id) on delete cascade,
  photo_id  uuid references photos(id) on delete set null,
  kind      text not null check (kind in ('single','zip')),
  ip_hash   text,
  at        timestamptz not null default now()
);

-- 公開停止・削除依頼
create table if not exists takedown_requests (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid references groups(id) on delete set null,
  photo_id    uuid references photos(id) on delete set null,
  requester   text,
  reason      text,
  status      text not null default 'open' check (status in ('open','done','rejected')),
  handled_by  uuid references staff_users(id),
  created_at  timestamptz not null default now(),
  handled_at  timestamptz
);

create table if not exists audit_logs (
  id          bigserial primary key,
  staff_id    uuid references staff_users(id),
  action      text not null,
  target_type text,
  target_id   text,
  detail      jsonb,
  at          timestamptz not null default now()
);
create index if not exists audit_at_idx on audit_logs(at desc);

-- =============================================================================
-- 価格計算 (唯一の正)
--   n 枚を選んだとき: 3 枚ごとに set3、余りは (余り×single) と set3 の安い方。
--   その額が pack 以上なら「全写真パック」(= 購入可能な残り全部) に自動で切り替える。
--   例 (500/1000/2000): 1→500 2→1000 3→1000 4→1500 5→2000(パック) 6→2000(パック)
-- =============================================================================
create or replace function photo_calc_price(p_n integer, p_remaining integer)
returns table(amount integer, pack boolean)
language plpgsql stable as $$
declare
  v_single integer := photo_setting_int('prices','single');
  v_set3   integer := photo_setting_int('prices','set3');
  v_pack   integer := photo_setting_int('prices','pack');
  v_cost   integer;
begin
  if p_n is null or p_n < 1 then
    raise exception 'empty_selection';
  end if;
  v_cost := (p_n / 3) * v_set3 + least((p_n % 3) * v_single, v_set3);
  if v_pack > 0 and v_cost >= v_pack and p_n <= p_remaining then
    return query select v_pack, true;
  else
    return query select v_cost, false;
  end if;
end $$;

-- 購入できる写真 = 公開中 (ready) で、まだ誰も購入していない写真
create or replace function photo_remaining_ids(p_group uuid) returns setof uuid
language sql stable as $$
  select p.id from photos p
  where p.group_id = p_group and p.status = 'ready'
    and not exists (select 1 from order_items i where i.photo_id = p.id and i.counted)
  order by p.taken_at, p.id
$$;

-- =============================================================================
-- 注文 (決済前) の作成: サーバー側で購入内容を検証し、重複を防ぐ
--   p_pack = true なら「購入可能な残り全部」を対象にする
--   エラーは message の先頭語で判別: group_not_available / photo_not_available /
--   already_purchased / email_required / empty_selection
-- =============================================================================
create or replace function photo_create_pending_order(
  p_token text, p_photo_ids uuid[], p_email text, p_pack boolean default false)
returns table(order_id uuid, order_token text, amount_jpy integer, photo_count integer, pack_applied boolean)
language plpgsql as $$
declare
  g          groups%rowtype;
  v_ids      uuid[];
  v_remain   integer;
  v_amount   integer;
  v_pack     boolean;
  v_order    orders%rowtype;
begin
  if p_email is null or position('@' in p_email) < 2 then
    raise exception 'email_required';
  end if;

  select * into g from groups where qr_token = p_token;
  if not found then raise exception 'group_not_available'; end if;

  -- 同じ団体への同時注文を直列化
  perform pg_advisory_xact_lock(hashtextextended(g.id::text, 0));

  if g.status <> 'published' or not g.online_ok or now() >= photo_view_end(g.shoot_date) then
    raise exception 'group_not_available';
  end if;

  select count(*) into v_remain from photo_remaining_ids(g.id);

  if p_pack then
    select array_agg(x) into v_ids from photo_remaining_ids(g.id) x;
  else
    select array_agg(distinct x) into v_ids from unnest(p_photo_ids) x;
    if v_ids is null then raise exception 'empty_selection'; end if;
    -- 全部がこのグループの公開写真か
    if (select count(*) from photos p
         where p.id = any(v_ids) and p.group_id = g.id and p.status = 'ready') <> cardinality(v_ids) then
      raise exception 'photo_not_available';
    end if;
    -- 購入済みを含まないか
    if exists (select 1 from order_items i where i.photo_id = any(v_ids) and i.counted) then
      raise exception 'already_purchased';
    end if;
  end if;

  if v_ids is null or cardinality(v_ids) = 0 then raise exception 'empty_selection'; end if;

  select c.amount, c.pack into v_amount, v_pack from photo_calc_price(cardinality(v_ids), v_remain) c;
  if v_pack then
    select array_agg(x) into v_ids from photo_remaining_ids(g.id) x;
  end if;

  insert into orders(group_id, email, amount_jpy, photo_count, pack_applied, pricing_snapshot)
  values (g.id, p_email, v_amount, cardinality(v_ids), v_pack,
          jsonb_build_object('prices', (select value from settings where key = 'prices'),
                             'selected', cardinality(v_ids), 'remaining', v_remain))
  returning * into v_order;

  insert into order_items(order_id, photo_id, group_id)
  select v_order.id, x, g.id from unnest(v_ids) x;

  return query select v_order.id, v_order.order_token, v_order.amount_jpy,
                      v_order.photo_count, v_order.pack_applied;
end $$;

-- =============================================================================
-- 決済確定 (Webhook から。冪等)
--   金額不一致、または同じ写真が別注文で先に確定していた (二重決済) 場合は
--   'needs_review' にして管理者の確認・返金に回す (写真は渡さない)
-- =============================================================================
create or replace function photo_finalize_order(
  p_order uuid, p_payment_intent text, p_amount integer)
returns text
language plpgsql as $$
declare
  o orders%rowtype;
  v_dl timestamptz;
  v_paid_days integer := coalesce(photo_setting_int('retention','purchased_days'), 30);
  v_max_days  integer := coalesce(photo_setting_int('retention','purchased_max_days'), 60);
  v_shoot date;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;

  if o.status in ('paid','partially_refunded','refunded') then
    return o.status;                                  -- 再送されたWebhook
  end if;

  if p_amount is distinct from o.amount_jpy then
    update orders set status = 'needs_review', stripe_payment_intent = p_payment_intent,
           review_reason = 'amount_mismatch', paid_at = now() where id = o.id;
    return 'needs_review';
  end if;

  begin
    update order_items set counted = true where order_id = o.id;
  exception when unique_violation then
    update orders set status = 'needs_review', stripe_payment_intent = p_payment_intent,
           review_reason = 'duplicate_purchase', paid_at = now() where id = o.id;
    return 'needs_review';
  end;

  select shoot_date into v_shoot from groups where id = o.group_id;
  v_dl := least(now() + make_interval(days => v_paid_days),
                ((v_shoot + v_max_days + 1)::timestamp) at time zone 'Asia/Tokyo');

  update orders set status = 'paid', stripe_payment_intent = p_payment_intent,
         paid_at = now(), download_expires_at = v_dl, review_reason = null
   where id = o.id;
  return 'paid';
end $$;

-- 全額返金: 写真を再び購入可能に戻し、ダウンロードも止める
create or replace function photo_refund_order_full(
  p_order uuid, p_stripe_refund text, p_staff uuid, p_reason text)
returns void
language plpgsql as $$
declare o orders%rowtype;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;
  insert into refunds(order_id, stripe_refund_id, amount_jpy, reason, staff_id)
  values (p_order, p_stripe_refund, o.amount_jpy, p_reason, p_staff)
  on conflict (stripe_refund_id) do nothing;
  update order_items set counted = false where order_id = p_order;
  update orders set status = 'refunded' where id = p_order;
end $$;

-- 決済に至らなかった注文を片付ける (cron)
create or replace function photo_expire_pending_orders(p_minutes integer default 120)
returns integer
language sql as $$
  with u as (
    update orders set status = 'expired'
     where status = 'pending' and created_at < now() - make_interval(mins => p_minutes)
    returning 1)
  select count(*)::int from u
$$;

-- =============================================================================
-- 保存期間: 削除対象の写真 (cron が R2 のファイルを消し、status を deleted にする)
--   purge_kind = 'all'          原本・プレビュー・サムネすべて
--              = 'preview_only' 閲覧期間が終わった購入済み写真 (原本はDL期限まで残す)
-- =============================================================================
create or replace function photos_to_purge(p_now timestamptz default now())
returns table(photo_id uuid, group_id uuid, purge_kind text)
language sql stable as $$
  select p.id, p.group_id,
         case
           when g.status = 'deleted' or p.status = 'pending_delete' then 'all'
           when dl.last_dl is null and p_now >= photo_view_end(g.shoot_date) then 'all'
           when dl.last_dl is not null and p_now >= dl.last_dl then 'all'
           else 'preview_only'
         end
  from photos p
  join groups g on g.id = p.group_id
  left join lateral (
    select max(o.download_expires_at) as last_dl
    from order_items i join orders o on o.id = i.order_id
    where i.photo_id = p.id and i.counted
  ) dl on true
  where p.status <> 'deleted'
    and (
      g.status = 'deleted' or p.status = 'pending_delete'
      or (dl.last_dl is null and p_now >= photo_view_end(g.shoot_date))
      or (dl.last_dl is not null and p_now >= dl.last_dl)
      or (dl.last_dl is not null and p_now >= photo_view_end(g.shoot_date) and p.status = 'ready')
    )
$$;

-- =============================================================================
-- 分析ビュー (全写真パックは「団体全員分」なので、人数あたりの売上も見る)
-- =============================================================================
create or replace view v_group_sales as
select
  g.id as group_id, g.shoot_date, g.start_time, g.name, g.headcount, g.plan,
  (select count(*) from photos p where p.group_id = g.id and p.status = 'ready') as photo_count,
  count(o.id) filter (where o.status in ('paid','partially_refunded')) as paid_orders,
  count(o.id) filter (where o.status in ('paid','partially_refunded') and o.pack_applied) as pack_orders,
  coalesce(sum(o.photo_count) filter (where o.status in ('paid','partially_refunded')), 0) as paid_photos,
  coalesce(sum(o.amount_jpy)  filter (where o.status in ('paid','partially_refunded')), 0) as revenue_jpy,
  count(o.id) filter (where o.status = 'needs_review') as needs_review_orders,
  case when g.headcount > 0
       then round(coalesce(sum(o.amount_jpy) filter (where o.status in ('paid','partially_refunded')), 0)::numeric
                  / g.headcount, 0) end as revenue_per_head_jpy,
  bool_or(o.status in ('paid','partially_refunded')) is true as has_purchase
from groups g left join orders o on o.group_id = g.id
where g.status <> 'deleted'
group by g.id;

create or replace view v_daily_sales as
select (o.paid_at at time zone 'Asia/Tokyo')::date as sale_date,
       count(*) as orders, sum(o.amount_jpy) as revenue_jpy, sum(o.photo_count) as photos,
       count(*) filter (where o.pack_applied) as pack_orders
from orders o
where o.status in ('paid','partially_refunded')
group by 1;

-- =============================================================================
-- RLS / 権限: anon・authenticated には何も許さない。Worker が service_role で操作する
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array['staff_users','settings','groups','photos','tv_state','orders',
    'order_items','stripe_events','refunds','download_events','takedown_requests','audit_logs']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant all on all tables in schema public to service_role;
    grant all on all sequences in schema public to service_role;
    grant execute on all functions in schema public to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke execute on all functions in schema public from anon, authenticated, public;
  end if;
end $$;
