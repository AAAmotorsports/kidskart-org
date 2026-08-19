-- =============================================================================
-- A-ONE 予約システム v1 — 初期スキーマ
-- =============================================================================
-- 対象: A-ONE サーキットの
--   スポーツ走行 / RP (レースパック) / 貸切 / ナイター
--   + 天候による営業状態 / レース・イベント等のブロック / 顧客管理
--
-- 設計方針
--   * 予約は「Web / 電話 / 店頭」を区別せず **同一台帳** (aone_reservations)
--     に入れる。source 列で入力経路だけを記録する。
--     → 電話予約を入れた瞬間、Web の空き状況に反映される。
--   * 受付可否ルールは **SQL 側 (0002) が唯一の正**。画面はその結果を
--     表示するだけ。二重実装しない。
--   * 通常ルールは自動判定するが、管理者は forced = true で常に上書きできる
--     (仕様 15「管理者の強制操作」)。
--
-- 適用: Supabase SQL Editor で 0001 → 0002 → 0003 の順に手動実行。
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. 設定 (単一行)
-- -----------------------------------------------------------------------------
-- 「通常ルール」の数値をすべてここに寄せる。現場都合でルールが動いても
-- コードを触らず /admin/settings から変更できるようにするため。
create table if not exists aone_settings (
  id smallint primary key default 1 check (id = 1),

  -- スポーツ走行: 同時に受け付ける「クラス」数の上限
  -- 同一カテゴリーは何台入っても 1 クラス扱い (仕様 2)
  max_classes_weekday_am smallint not null default 2,
  max_classes_weekday_pm smallint not null default 2,
  max_classes_holiday_am smallint not null default 2,
  max_classes_holiday_pm smallint not null default 1,

  -- 走行時間 (仕様 2)
  course_open_time  time not null default '08:30',
  am_start_time     time not null default '09:00',
  am_end_time       time not null default '12:00',
  pm_start_time     time not null default '13:00',
  pm_end_time       time not null default '16:30',
  course_close_time time not null default '17:30',

  -- RP (仕様 3)
  rp_min_party            smallint not null default 3,   -- 3 名以上から
  rp_first_start_time     time not null default '10:00',
  rp_last_start_time      time not null default '17:00', -- 通常の最終受付
  rp_late_limit_time      time not null default '18:00', -- これ以降は受付しない
  rp_slot_minutes         smallint not null default 30,  -- 30 分刻み
  rp_duration_minutes     smallint not null default 90,  -- 1 グループの占有時間
  rp_max_groups_per_start smallint not null default 2,   -- 同一開始時刻の上限
  rp_groups_block_sport   smallint not null default 3,   -- この数以上でスポーツ停止

  -- キャンセル規定 (仕様 9)
  rp_cancel_deadline_hours smallint not null default 24, -- RP・貸切は 24h 前から 100%

  -- 貸切 (仕様 5)
  charter_first_start_time time not null default '09:00',
  charter_last_end_time    time not null default '17:30',

  updated_at timestamptz not null default now(),
  updated_by text
);

insert into aone_settings (id) values (1) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 2. スポーツ走行カテゴリー (仕様 2)
-- -----------------------------------------------------------------------------
create table if not exists aone_categories (
  code       text primary key,
  name       text not null,
  short_name text,
  sort_order smallint not null default 0,
  is_active  boolean not null default true,
  note       text
);

insert into aone_categories (code, name, short_name, sort_order) values
  ('kart',     'カート',       'カート',   10),
  ('minibike', 'ミニバイク',   'ミニバイク', 20),
  ('kidskart', 'キッズカート', 'キッズ',   30),
  ('other',    'その他 (大型バイク等)', 'その他', 40)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 3. 祝日テーブル
-- -----------------------------------------------------------------------------
-- 土日祝は「午後 1 クラス」など受付枠が変わる (仕様 2) ので、判定を DB 側に
-- 持たせる必要がある。毎年 2 月の官報告示に合わせて追記する。
create table if not exists aone_holidays (
  date date primary key,
  name text not null
);

-- -----------------------------------------------------------------------------
-- 4. 営業日ステータス (仕様 8 天候管理)
-- -----------------------------------------------------------------------------
-- レコードが無い日は「通常営業 (normal)」とみなす。
create table if not exists aone_business_days (
  date date primary key,
  weather_status text not null default 'normal'
    check (weather_status in (
      'normal',           -- 通常営業
      'rain_caution',     -- 雨天注意
      'checking',         -- 営業確認中
      'surface_recovery', -- 路面回復待ち
      'cancelled',        -- 雨天中止
      'other'             -- その他
    )),
  status_message text,   -- 公開用の一言 (「11 時に再判断します」等)
  staff_note     text,   -- スタッフ用メモ (非公開)
  updated_at timestamptz not null default now(),
  updated_by text
);

-- -----------------------------------------------------------------------------
-- 5. ブロック予定 (仕様 14 レース・イベント / メンテナンス / 臨時休業)
-- -----------------------------------------------------------------------------
-- 「何を止めるか」を scope + blocks_* フラグ + category_code で表現する。
--   scope='all'      終日すべて停止
--   scope='am'/'pm'  午前 / 午後のみ停止
--   scope='time'     start_time〜end_time のみ停止
--   scope='sport'    スポーツ走行のみ停止 (終日 or 時間指定)
--   scope='rp'       RP のみ停止
--   scope='category' 特定カテゴリーのスポーツ走行のみ停止
create table if not exists aone_blocks (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  kind text not null default 'event'
    check (kind in ('race','event','kids_event','charter','maintenance','closed','other')),
  title text not null,
  scope text not null default 'all'
    check (scope in ('all','am','pm','time','sport','rp','category')),
  category_code text references aone_categories(code),
  start_time time,
  end_time   time,

  -- scope が時間帯系のとき、どの予約種別を止めるか
  blocks_sport   boolean not null default true,
  blocks_rp      boolean not null default true,
  blocks_charter boolean not null default true,

  is_public    boolean not null default true, -- 公開スケジュールに載せるか (仕様 19)
  public_label text,                          -- 公開時の表記 (未指定なら title)
  memo text,

  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists aone_blocks_date_idx on aone_blocks (date);

-- -----------------------------------------------------------------------------
-- 6. 顧客 (仕様 16)
-- -----------------------------------------------------------------------------
create table if not exists aone_customers (
  id uuid primary key default gen_random_uuid(),
  name  text not null,
  kana  text,
  phone text,
  email text,
  postal_code text,
  address text,
  tags  text[] not null default '{}',   -- 常連 / 初心者 / 大型バイク 等 (仕様 17)
  staff_memo text,                      -- 顧客には表示しない
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 電話番号・メールを名寄せキーにする (仕様 16)。
-- 空文字は NULL 相当として扱いたいので partial unique index にする。
create unique index if not exists aone_customers_email_uidx
  on aone_customers (lower(email)) where email is not null and email <> '';
create index if not exists aone_customers_phone_idx
  on aone_customers (phone) where phone is not null and phone <> '';
create index if not exists aone_customers_name_idx on aone_customers (name);

-- -----------------------------------------------------------------------------
-- 7. 予約台帳 (Web / 電話 / 店頭を統合 — 仕様 13)
-- -----------------------------------------------------------------------------
create sequence if not exists aone_reservation_seq;

create or replace function aone_next_reservation_number() returns text
language sql volatile as $$
  select 'A' || to_char((now() at time zone 'Asia/Tokyo')::date, 'YYMMDD')
       || '-' || lpad((nextval('aone_reservation_seq') % 10000)::text, 4, '0');
$$;

create table if not exists aone_reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_number text unique not null default aone_next_reservation_number(),

  kind text not null check (kind in ('sport','rp','charter','night')),

  -- 状態遷移 (仕様 5): 受付 → 連絡待ち → 確認中 → 確定 → 完了
  status text not null default 'confirmed'
    check (status in (
      'confirmed',    -- 確定
      'contact_wait', -- 連絡待ち (A-ONE から折り返す)
      'checking',     -- 確認中
      'completed',    -- 完了 (来場・走行済)
      'cancelled',    -- キャンセル
      'no_show'       -- 無断キャンセル (仕様 9)
    )),

  date date not null,
  session text check (session in ('am','pm')),  -- スポーツ走行の午前/午後
  start_time time,                              -- RP / 貸切 / ナイター
  end_time   time,
  category_code text references aone_categories(code),  -- スポーツ走行 / ナイター

  party_size    smallint not null default 1,  -- 参加人数
  vehicle_count smallint,                     -- 台数 (スポーツ走行)

  customer_id uuid references aone_customers(id) on delete set null,
  contact_name  text not null,
  contact_kana  text,
  contact_phone text,
  contact_email text,
  preferred_contact text check (preferred_contact in ('email','phone')), -- 仕様 5

  source text not null default 'web' check (source in ('web','phone','counter','admin')),

  request_note text,   -- 顧客からの要望・備考
  staff_memo   text,   -- スタッフ専用メモ (仕様 17)。顧客には表示しない
  tags text[] not null default '{}',

  amount  integer,                        -- 料金 (円・現地払い前提 — 仕様 18)
  is_paid boolean not null default false,
  payment_method text,                    -- 将来の事前決済拡張用

  forced        boolean not null default false,  -- 管理者の強制受付 (仕様 15)
  forced_reason text,

  access_token uuid not null default gen_random_uuid(), -- 予約者専用 URL (仕様 10)
  terms_agreed_at timestamptz,                          -- キャンセル規定への同意

  cancelled_at  timestamptz,
  cancel_reason text,
  cancelled_by  text,

  -- 自動メール送信済みフラグ (仕様 11)
  confirm_mail_sent_at  timestamptz,
  reminder_mail_sent_at timestamptz,
  thanks_mail_sent_at   timestamptz,
  followup_mail_sent_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,

  -- 種別ごとの必須項目
  constraint aone_res_sport_shape check (
    kind <> 'sport' or (session is not null and category_code is not null)
  ),
  constraint aone_res_rp_shape check (
    kind <> 'rp' or start_time is not null
  ),
  constraint aone_res_charter_shape check (
    kind <> 'charter' or (start_time is not null and end_time is not null)
  )
);

create index if not exists aone_res_date_idx    on aone_reservations (date);
create index if not exists aone_res_date_kind_idx on aone_reservations (date, kind, status);
create index if not exists aone_res_customer_idx on aone_reservations (customer_id);
create unique index if not exists aone_res_token_uidx on aone_reservations (access_token);

-- 「生きている予約」= 枠を消費する予約。キャンセル / 無断キャンセルは除く。
create or replace function aone_is_live(p_status text) returns boolean
language sql immutable as $$
  select p_status in ('confirmed','contact_wait','checking','completed');
$$;

-- -----------------------------------------------------------------------------
-- 8. 予約イベント履歴 (監査)
-- -----------------------------------------------------------------------------
create table if not exists aone_reservation_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references aone_reservations(id) on delete cascade,
  event text not null,      -- created / updated / cancelled / no_show / forced / status
  actor text,               -- 'customer' / 'admin' / スタッフ名
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists aone_res_events_res_idx on aone_reservation_events (reservation_id);

-- -----------------------------------------------------------------------------
-- 9. メール送信ログ / 一括連絡 (仕様 8, 11)
-- -----------------------------------------------------------------------------
create table if not exists aone_mail_log (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid references aone_reservations(id) on delete set null,
  kind text not null,        -- confirm / reminder / thanks / followup / broadcast / admin
  to_email text not null,
  subject text,
  ok boolean not null default true,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists aone_mail_log_created_idx on aone_mail_log (created_at desc);

create table if not exists aone_broadcasts (
  id uuid primary key default gen_random_uuid(),
  date date not null,        -- 対象営業日
  subject text not null,
  body text not null,
  recipient_count integer not null default 0,
  created_at timestamptz not null default now(),
  created_by text
);

-- -----------------------------------------------------------------------------
-- 10. 顧客サマリ VIEW (仕様 16)
-- -----------------------------------------------------------------------------
create or replace view aone_customer_stats as
select
  c.id,
  c.name, c.kana, c.phone, c.email, c.tags, c.staff_memo,
  c.created_at,
  count(r.id) filter (where r.kind = 'rp'      and aone_is_live(r.status)) as rp_count,
  count(r.id) filter (where r.kind = 'sport'   and aone_is_live(r.status)) as sport_count,
  count(r.id) filter (where r.kind = 'charter' and aone_is_live(r.status)) as charter_count,
  count(r.id) filter (where r.kind = 'night'   and aone_is_live(r.status)) as night_count,
  count(r.id) filter (where r.status = 'cancelled') as cancel_count,
  count(r.id) filter (where r.status = 'no_show')   as no_show_count,
  max(r.date) filter (where aone_is_live(r.status)
                        and r.date <= (now() at time zone 'Asia/Tokyo')::date) as last_visit_date,
  min(r.date) filter (where aone_is_live(r.status)) as first_reservation_date
from aone_customers c
left join aone_reservations r on r.customer_id = c.id
group by c.id;

-- -----------------------------------------------------------------------------
-- 11. updated_at 自動更新
-- -----------------------------------------------------------------------------
create or replace function aone_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists aone_res_touch on aone_reservations;
create trigger aone_res_touch before update on aone_reservations
  for each row execute function aone_touch_updated_at();

drop trigger if exists aone_cust_touch on aone_customers;
create trigger aone_cust_touch before update on aone_customers
  for each row execute function aone_touch_updated_at();
