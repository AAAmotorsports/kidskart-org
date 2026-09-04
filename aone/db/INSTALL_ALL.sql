-- =============================================================================
-- A-ONE 予約システム v1 — 初回インストール用 (連番マイグレーションを結合)
-- =============================================================================
-- ★ 新規 Supabase プロジェクトへの初回適用専用です。
--    Supabase Dashboard → SQL Editor に全文を貼り付けて Run を 1 回押すだけ。
--
-- ★ 2 回目以降 (運用開始後) は、このファイルではなく db/000N_*.sql を
--    連番で追加していってください。
--
-- このファイルは生成物です。中身を直接編集しないこと。再生成:
--   cd aone/db && ./build_install_all.sh
-- =============================================================================


-- ###########################################################################
-- # 0001_initial_schema.sql
-- ###########################################################################

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

-- ###########################################################################
-- # 0002_seed_holidays.sql
-- ###########################################################################

-- =============================================================================
-- A-ONE 予約システム — 祝日マスタ (2025〜2028)
-- =============================================================================
-- 土日祝は受付クラス数が変わる (仕様 2: 土日祝 午後は最大 1 クラス) ため、
-- 判定に必要な祝日を DB に持つ。春分・秋分は前年 2 月の官報告示で確定する
-- ので、毎年 1 年分を追記していくこと (このファイルではなく新しい連番の
-- マイグレーションで追加する)。
-- =============================================================================

insert into aone_holidays (date, name) values
  ('2025-01-01', '元日'),
  ('2025-01-13', '成人の日'),
  ('2025-02-11', '建国記念の日'),
  ('2025-02-23', '天皇誕生日'),
  ('2025-02-24', '振替休日'),
  ('2025-03-20', '春分の日'),
  ('2025-04-29', '昭和の日'),
  ('2025-05-03', '憲法記念日'),
  ('2025-05-04', 'みどりの日'),
  ('2025-05-05', 'こどもの日'),
  ('2025-05-06', '振替休日'),
  ('2025-07-21', '海の日'),
  ('2025-08-11', '山の日'),
  ('2025-09-15', '敬老の日'),
  ('2025-09-23', '秋分の日'),
  ('2025-10-13', 'スポーツの日'),
  ('2025-11-03', '文化の日'),
  ('2025-11-23', '勤労感謝の日'),
  ('2025-11-24', '振替休日'),
  ('2026-01-01', '元日'),
  ('2026-01-12', '成人の日'),
  ('2026-02-11', '建国記念の日'),
  ('2026-02-23', '天皇誕生日'),
  ('2026-03-20', '春分の日'),
  ('2026-04-29', '昭和の日'),
  ('2026-05-03', '憲法記念日'),
  ('2026-05-04', 'みどりの日'),
  ('2026-05-05', 'こどもの日'),
  ('2026-05-06', '振替休日'),
  ('2026-07-20', '海の日'),
  ('2026-08-11', '山の日'),
  ('2026-09-21', '敬老の日'),
  ('2026-09-22', '国民の休日'),
  ('2026-09-23', '秋分の日'),
  ('2026-10-12', 'スポーツの日'),
  ('2026-11-03', '文化の日'),
  ('2026-11-23', '勤労感謝の日'),
  ('2027-01-01', '元日'),
  ('2027-01-11', '成人の日'),
  ('2027-02-11', '建国記念の日'),
  ('2027-02-23', '天皇誕生日'),
  ('2027-03-21', '春分の日'),
  ('2027-03-22', '振替休日'),
  ('2027-04-29', '昭和の日'),
  ('2027-05-03', '憲法記念日'),
  ('2027-05-04', 'みどりの日'),
  ('2027-05-05', 'こどもの日'),
  ('2027-07-19', '海の日'),
  ('2027-08-11', '山の日'),
  ('2027-09-20', '敬老の日'),
  ('2027-09-23', '秋分の日'),
  ('2027-10-11', 'スポーツの日'),
  ('2027-11-03', '文化の日'),
  ('2027-11-23', '勤労感謝の日'),
  ('2028-01-01', '元日'),
  ('2028-01-10', '成人の日'),
  ('2028-02-11', '建国記念の日'),
  ('2028-02-23', '天皇誕生日'),
  ('2028-03-20', '春分の日'),
  ('2028-04-29', '昭和の日'),
  ('2028-05-03', '憲法記念日'),
  ('2028-05-04', 'みどりの日'),
  ('2028-05-05', 'こどもの日'),
  ('2028-07-17', '海の日'),
  ('2028-08-11', '山の日'),
  ('2028-09-18', '敬老の日'),
  ('2028-09-22', '秋分の日'),
  ('2028-10-09', 'スポーツの日'),
  ('2028-11-03', '文化の日'),
  ('2028-11-23', '勤労感謝の日')
on conflict (date) do nothing;

-- ###########################################################################
-- # 0003_availability_engine.sql
-- ###########################################################################

-- =============================================================================
-- A-ONE 予約システム — 受付可否ルールエンジン
-- =============================================================================
-- ★ このファイルが受付ルールの **唯一の正** です。
--   画面 (Astro) は aone_day_state() / aone_check_availability() の結果を
--   表示するだけで、同じルールを TypeScript 側に再実装してはいけません。
--   (二重実装するとカレンダーの表示と実際の受付結果がズレる)
--
-- ルール要約
--   スポーツ走行 (仕様 2)
--     * 同一カテゴリーは何台入っても 1 クラス
--     * 平日 午前/午後 2 クラス、土日祝 午前 2 クラス・午後 1 クラス
--   RP (仕様 3)
--     * 3 名以上、10:00〜17:00 の 30 分刻み (17:00 以降は要相談)
--     * 同一開始時刻は 2 グループまで
--     * RP が同時 3 グループ以上になった時間帯はスポーツ走行の新規受付停止
--   貸切 (仕様 5)
--     * 他予約が無ければ受付 → 確定でその時間帯の他予約を全停止
--     * 他予約があれば申込は受けるが「連絡待ち」扱い
--   ナイター (仕様 6)
--     * 常に要相談 (確認中で受付)
--   管理者は forced = true ですべてを上書きできる (仕様 15)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 土日祝判定
-- -----------------------------------------------------------------------------
create or replace function aone_is_holiday(p_date date) returns boolean
language sql stable as $$
  select extract(dow from p_date) in (0, 6)
      or exists (select 1 from aone_holidays h where h.date = p_date);
$$;

-- 今日 (JST)
create or replace function aone_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;

-- -----------------------------------------------------------------------------
-- セッション (午前/午後) の走行時間帯
-- -----------------------------------------------------------------------------
create or replace function aone_session_window(p_session text)
returns table (start_time time, end_time time)
language sql stable as $$
  select
    case when p_session = 'am' then s.am_start_time else s.pm_start_time end,
    case when p_session = 'am' then s.am_end_time   else s.pm_end_time   end
  from aone_settings s where s.id = 1;
$$;

-- -----------------------------------------------------------------------------
-- ブロック予定がある予約要求に当たるか
-- -----------------------------------------------------------------------------
-- p_kind      : 'sport' | 'rp' | 'charter' | 'night'
-- p_category  : スポーツ走行のカテゴリー (それ以外は null)
-- p_start/p_end: 対象の時間帯 (スポーツ走行はセッションの走行時間)
create or replace function aone_blocking_blocks(
  p_date     date,
  p_kind     text,
  p_category text,
  p_start    time,
  p_end      time
)
returns table (id uuid, title text, kind text, scope text)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  win as (
    select b.*,
      case b.scope
        when 'am'   then (select course_open_time from s)
        when 'pm'   then (select pm_start_time    from s)
        when 'time' then coalesce(b.start_time, time '00:00')
        else coalesce(b.start_time, time '00:00')
      end as w_start,
      case b.scope
        when 'am'   then (select am_end_time       from s)
        when 'pm'   then (select course_close_time from s)
        when 'time' then coalesce(b.end_time, time '23:59:59')
        else coalesce(b.end_time, time '23:59:59')
      end as w_end
    from aone_blocks b
    where b.date = p_date
  )
  select w.id, w.title, w.kind, w.scope
  from win w
  where
    -- 対象の予約種別に効くか
    case
      when w.scope = 'sport'    then p_kind = 'sport'
      when w.scope = 'rp'       then p_kind = 'rp'
      when w.scope = 'category' then p_kind = 'sport'
                                  and (w.category_code is null or w.category_code = p_category)
      else
        case p_kind
          when 'sport'   then w.blocks_sport
          when 'night'   then w.blocks_sport
          when 'rp'      then w.blocks_rp
          when 'charter' then w.blocks_charter
          else true
        end
    end
    -- 時間帯が重なるか (時刻未指定のブロックは終日扱い)
    and w.w_start < coalesce(p_end, time '23:59:59')
    and w.w_end   > coalesce(p_start, time '00:00');
$$;

-- -----------------------------------------------------------------------------
-- 指定時間帯に重なる「生きている」予約
-- -----------------------------------------------------------------------------
-- RP / 貸切 / ナイターは start_time〜end_time、スポーツ走行は session の
-- 走行時間帯を占有しているものとして扱う。
create or replace function aone_live_reservations_in_window(
  p_date    date,
  p_start   time,
  p_end     time,
  p_exclude uuid default null
)
returns table (
  id uuid, kind text, status text, start_time time, end_time time,
  category_code text, party_size smallint, contact_name text
)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  expanded as (
    select r.id, r.kind, r.status, r.category_code, r.party_size, r.contact_name,
      case
        when r.kind = 'sport' and r.session = 'am' then (select am_start_time from s)
        when r.kind = 'sport' and r.session = 'pm' then (select pm_start_time from s)
        else r.start_time
      end as w_start,
      case
        when r.kind = 'sport' and r.session = 'am' then (select am_end_time from s)
        when r.kind = 'sport' and r.session = 'pm' then (select pm_end_time from s)
        when r.kind = 'rp' then coalesce(
          r.end_time,
          (r.start_time + make_interval(mins => (select rp_duration_minutes from s)))::time)
        else coalesce(r.end_time, (r.start_time + interval '1 hour')::time)
      end as w_end
    from aone_reservations r
    where r.date = p_date
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude)
  )
  select e.id, e.kind, e.status, e.w_start, e.w_end, e.category_code, e.party_size, e.contact_name
  from expanded e
  where e.w_start < coalesce(p_end, time '23:59:59')
    and e.w_end   > coalesce(p_start, time '00:00');
$$;

-- -----------------------------------------------------------------------------
-- 指定時間帯における RP の同時グループ数のピーク
-- -----------------------------------------------------------------------------
-- 「その時間帯に RP が何組重なっているか」の最大値。
-- スポーツ走行を止めるかどうか (rp_groups_block_sport) の判定に使う。
create or replace function aone_rp_peak_groups(
  p_date    date,
  p_start   time,
  p_end     time,
  p_exclude uuid default null
) returns integer
language sql stable as $$
  with rp as (
    select l.id, l.start_time, l.end_time
    from aone_live_reservations_in_window(p_date, p_start, p_end, p_exclude) l
    where l.kind = 'rp'
  ),
  -- 判定点: 各グループの開始時刻と対象時間帯の開始時刻
  points as (
    select start_time as t from rp
    union select coalesce(p_start, time '00:00')
  )
  select coalesce(max(c), 0)::int from (
    select (select count(*) from rp
             where rp.start_time <= p.t and rp.end_time > p.t) as c
    from points p
    where p.t < coalesce(p_end, time '23:59:59')
  ) x;
$$;

-- -----------------------------------------------------------------------------
-- 受付可否の判定 (中核)
-- -----------------------------------------------------------------------------
-- 戻り値 jsonb:
--   { ok: bool, status: '確定させるべき status', reason: 'コード',
--     message: '日本語の説明', detail: {...} }
create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 天候による営業状態 (仕様 8)
  select weather_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', '本日は雨天中止です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

-- -----------------------------------------------------------------------------
-- 1 日ぶんの状態 (「今日走れる？」/ 管理カレンダー/ 予約フォームの共通ソース)
-- -----------------------------------------------------------------------------
-- カテゴリー状態:
--   'open'    ○ 受付可
--   'limited' △ 残りわずか (このカテゴリーを入れると上限、または RP があと 1 組で停止)
--   'closed'  ✕ 受付停止 (クラス上限 / RP 飽和 / 貸切)
--   'off'     — 対象外 (雨天中止 / 終日ブロック / 過去日)
create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.weather_status, bd.status_message, bd.staff_note into v_weather
  from aone_business_days bd where bd.date = p_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        if (not coalesce(v_has_cat, false) and coalesce(v_classes, 0) + 1 >= v_limit)
           or v_peak = s.rp_groups_block_sport - 1 then
          v_status := 'limited';
        else
          v_status := 'open';
        end if;
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  -- rp_last_start_time (通常の最終受付) を過ぎた枠も rp_late_limit_time までは
  -- 「要相談」として出す (仕様 3: 17:00 以降は要相談)。
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'weather', jsonb_build_object(
      'status',  coalesce(v_weather.weather_status, 'normal'),
      'message', v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 月表示用のダイジェスト (管理カレンダー / 公開スケジュール)
-- -----------------------------------------------------------------------------
create or replace function aone_month_state(p_year integer, p_month integer) returns jsonb
language sql stable as $$
  with days as (
    select generate_series(
      make_date(p_year, p_month, 1),
      (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
      interval '1 day')::date as d
  ),
  -- MATERIALIZED が必須: 付けないと下で st を参照するたびに
  -- aone_day_state() が再評価され、1 か月ぶんで数秒かかる。
  states as materialized (
    select d, aone_day_state(d) as st from days
  )
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'),
      'dow', extract(dow from d)::int,
      'is_holiday', st->>'is_holiday' = 'true',
      'weather', st->'weather'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
      'rp_free', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                   where (s->>'accepting')::boolean),
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                          'title', b->>'title',
                          'public_label', b->>'public_label',
                          'kind', b->>'kind',
                          'is_public', (b->>'is_public')::boolean)), '[]'::jsonb)
                 from jsonb_array_elements(st->'blocks') b),
      'counts', st->'counts'
    ) as x
    from states
  ) y;
$$;

-- ###########################################################################
-- # 0004_reservation_rpcs.sql
-- ###########################################################################

-- =============================================================================
-- A-ONE 予約システム — 予約の作成 / 変更 / キャンセル RPC
-- =============================================================================
-- Web も電話も店頭も、すべてこの RPC を通す (仕様 13: 予約台帳を分けない)。
--
-- 同時実行対策: 日付単位の advisory lock を取ってから空き判定 → INSERT まで
-- を 1 トランザクションで行う。REST 経由の 2 リクエストが同じ最後の 1 クラスを
-- 取り合っても、後から来た方は必ず class_full で弾かれる。
--
-- エラーは SQLSTATE 'AONE1' + HINT に理由コードを載せて返す。
-- API 層 (Astro) はその理由コードを HTTP ステータスに写像する。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 顧客の名寄せ (仕様 16: 電話番号・メールを基準に履歴をまとめる)
-- -----------------------------------------------------------------------------
create or replace function aone_upsert_customer(
  p_name  text,
  p_kana  text,
  p_phone text,
  p_email text
) returns uuid
language plpgsql volatile as $$
declare
  v_id    uuid;
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  if v_email is not null then
    select id into v_id from aone_customers where lower(email) = v_email limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from aone_customers
    where regexp_replace(coalesce(phone, ''), '[^0-9+]', '', 'g') = v_phone
    order by created_at
    limit 1;
  end if;

  if v_id is null then
    insert into aone_customers (name, kana, phone, email)
    values (coalesce(nullif(trim(p_name), ''), '(名前未登録)'), nullif(trim(p_kana), ''),
            nullif(trim(p_phone), ''), v_email)
    returning id into v_id;
    return v_id;
  end if;

  -- 既存顧客: 空欄だけ埋める (スタッフが直した表記を Web 入力で潰さない)
  update aone_customers
     set kana  = coalesce(kana,  nullif(trim(p_kana), '')),
         phone = coalesce(nullif(trim(phone), ''), nullif(trim(p_phone), '')),
         email = coalesce(nullif(lower(trim(email)), ''), v_email)
   where id = v_id;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 予約作成
-- -----------------------------------------------------------------------------
-- payload:
-- {
--   kind: 'sport'|'rp'|'charter'|'night',
--   date: '2026-08-23',
--   session: 'am'|'pm',            -- sport
--   category_code: 'kart',         -- sport / night
--   start_time: '14:00',           -- rp / charter / night
--   end_time: '17:00',             -- charter
--   party_size: 5, vehicle_count: 2,
--   contact: { name, kana, phone, email },
--   preferred_contact: 'email'|'phone',
--   source: 'web'|'phone'|'counter'|'admin',
--   request_note, staff_memo, amount,
--   terms_agreed: true,
--   forced: false, forced_reason: '',   -- 管理者の強制受付 (仕様 15)
--   created_by: 'admin'
-- }
create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null);

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code,
    party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', '')
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 予約変更 (仕様 4 / 10: 予約者専用 URL から時間・人数を変更)
-- -----------------------------------------------------------------------------
-- payload: { access_token | id, start_time?, end_time?, session?, category_code?,
--            party_size?, vehicle_count?, contact{...}?, request_note?,
--            date?,                        -- 管理者のみ
--            forced?, actor? }
create or replace function aone_update_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s        aone_settings%rowtype;
  v_row    aone_reservations%rowtype;
  v_before jsonb;
  v_date   date;
  v_start  time;
  v_end    time;
  v_sess   text;
  v_cat    text;
  v_party  integer;
  v_forced boolean := coalesce((payload->>'forced')::boolean, false);
  v_check  jsonb;
  v_status text;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    raise exception 'この予約は既にキャンセルされています' using errcode = 'AONE1', hint = 'already_cancelled';
  end if;

  v_before := to_jsonb(v_row);

  v_date  := coalesce(nullif(payload->>'date', '')::date, v_row.date);
  v_sess  := coalesce(nullif(payload->>'session', ''), v_row.session);
  v_cat   := coalesce(nullif(payload->>'category_code', ''), v_row.category_code);
  v_party := coalesce(nullif(payload->>'party_size', '')::int, v_row.party_size);
  v_start := coalesce(nullif(payload->>'start_time', '')::time, v_row.start_time);
  v_end   := nullif(payload->>'end_time', '')::time;

  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  if v_row.kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;
  elsif v_row.kind = 'rp' then
    v_end := coalesce(v_end, (v_start + make_interval(mins => s.rp_duration_minutes))::time);
  else
    v_end := coalesce(v_end, v_row.end_time);
  end if;

  -- 自分自身を除外して再判定 (仕様 4: 変更時に最新の空き状況を再判定)
  v_check := aone_check_availability(
    v_row.kind, v_date, v_cat, v_sess,
    case when v_row.kind = 'sport' then null else v_start end,
    case when v_row.kind = 'sport' then null else v_end end,
    v_party, v_row.id);

  if not (v_check->>'ok')::boolean and not v_forced then
    raise exception '%', v_check->>'message'
      using errcode = 'AONE1', hint = v_check->>'reason';
  end if;

  -- 確定済みの予約は、変更後も確定のまま維持する (要相談枠に落ちた場合を除く)
  v_status := case
    when v_row.status in ('confirmed', 'completed') and (v_check->>'status') = 'checking'
      then 'checking'
    else v_row.status
  end;

  update aone_reservations set
    date          = v_date,
    session       = v_sess,
    category_code = v_cat,
    start_time    = v_start,
    end_time      = v_end,
    party_size    = v_party,
    vehicle_count = coalesce(nullif(payload->>'vehicle_count', '')::int, vehicle_count),
    status        = v_status,
    contact_name  = coalesce(nullif(trim(payload->'contact'->>'name'), ''), contact_name),
    contact_kana  = coalesce(nullif(trim(payload->'contact'->>'kana'), ''), contact_kana),
    contact_phone = coalesce(nullif(trim(payload->'contact'->>'phone'), ''), contact_phone),
    contact_email = coalesce(nullif(lower(trim(payload->'contact'->>'email')), ''), contact_email),
    request_note  = coalesce(nullif(payload->>'request_note', ''), request_note),
    staff_memo    = coalesce(nullif(payload->>'staff_memo', ''), staff_memo),
    amount        = coalesce(nullif(payload->>'amount', '')::int, amount),
    forced        = forced or (v_forced and not (v_check->>'ok')::boolean)
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'updated', coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('before', v_before - 'access_token', 'check', v_check));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- キャンセル / 無断キャンセル (仕様 9)
-- -----------------------------------------------------------------------------
-- payload: { access_token | id, reason?, actor?, no_show? }
--
-- スポーツ走行は当日でも連絡があればキャンセル可・キャンセル料なし。
-- RP / 貸切は開始 24 時間前以降のキャンセルは料金 100% だが、システムは
-- 「キャンセル自体は受け付けて、料金発生フラグを返す」方針にする
-- (現場で個別対応できるようにするため — 仕様 20)。
create or replace function aone_cancel_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s          aone_settings%rowtype;
  v_row      aone_reservations%rowtype;
  v_no_show  boolean := coalesce((payload->>'no_show')::boolean, false);
  v_start_ts timestamptz;
  v_fee      boolean := false;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status,
                              'already', true, 'cancel_fee', false);
  end if;

  -- キャンセル料の判定 (RP / 貸切のみ)
  if v_row.kind in ('rp', 'charter') then
    v_start_ts := (v_row.date + coalesce(v_row.start_time, time '00:00'))
                    at time zone 'Asia/Tokyo';
    v_fee := (v_start_ts - now()) < make_interval(hours => s.rp_cancel_deadline_hours);
  end if;

  update aone_reservations set
    status        = case when v_no_show then 'no_show' else 'cancelled' end,
    cancelled_at  = now(),
    cancel_reason = nullif(payload->>'reason', ''),
    cancelled_by  = coalesce(nullif(payload->>'actor', ''), 'customer')
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_no_show then 'no_show' else 'cancelled' end,
          coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('reason', payload->>'reason', 'cancel_fee', v_fee));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'cancel_fee', v_fee,
    'cancel_deadline_hours', s.rp_cancel_deadline_hours
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- ステータス変更 (管理画面: 受付 → 連絡待ち → 確認中 → 確定 → 完了)
-- -----------------------------------------------------------------------------
create or replace function aone_set_reservation_status(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row    aone_reservations%rowtype;
  v_status text := payload->>'status';
begin
  if v_status is null then
    raise exception 'status は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;

  update aone_reservations
     set status = v_status,
         cancelled_at  = case when v_status in ('cancelled','no_show') then coalesce(cancelled_at, now()) else null end,
         cancel_reason = case when v_status in ('cancelled','no_show') then coalesce(cancel_reason, nullif(payload->>'reason','')) else null end,
         is_paid       = coalesce((payload->>'is_paid')::boolean, is_paid),
         staff_memo    = coalesce(nullif(payload->>'staff_memo',''), staff_memo)
   where id = (payload->>'id')::uuid
  returning * into v_row;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'status', coalesce(nullif(payload->>'actor',''), 'admin'),
          jsonb_build_object('status', v_status));

  return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status);
end;
$$;

-- ###########################################################################
-- # 0005_grants_and_rls.sql
-- ###########################################################################

-- =============================================================================
-- A-ONE 予約システム — RLS と権限
-- =============================================================================
-- 方針 (ASMS と同じ):
--   * 公開 API (anon key) から読めるのは「非機微データ」だけ
--       カテゴリー / 設定 / 営業日ステータス / 公開ブロック / 祝日
--   * 予約・顧客テーブルは anon から一切読めない (PII)
--   * 空き状況は SECURITY DEFINER 関数で「集計結果だけ」返す
--       → 誰が何時に予約したかは漏れない
--   * 書き込み系 RPC は service_role のみ (Astro の API ルートから呼ぶ)
-- =============================================================================

alter table aone_settings       enable row level security;
alter table aone_categories     enable row level security;
alter table aone_holidays       enable row level security;
alter table aone_business_days  enable row level security;
alter table aone_blocks         enable row level security;
alter table aone_customers      enable row level security;
alter table aone_reservations   enable row level security;
alter table aone_reservation_events enable row level security;
alter table aone_mail_log       enable row level security;
alter table aone_broadcasts     enable row level security;

-- ---- 公開読み取り -----------------------------------------------------------
drop policy if exists aone_pub_read_settings on aone_settings;
create policy aone_pub_read_settings on aone_settings for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_categories on aone_categories;
create policy aone_pub_read_categories on aone_categories for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_holidays on aone_holidays;
create policy aone_pub_read_holidays on aone_holidays for select to anon, authenticated using (true);

drop policy if exists aone_pub_read_days on aone_business_days;
create policy aone_pub_read_days on aone_business_days for select to anon, authenticated using (true);

-- 公開フラグの立ったブロックのみ (社内メモ付きの非公開予定は隠す)
drop policy if exists aone_pub_read_blocks on aone_blocks;
create policy aone_pub_read_blocks on aone_blocks for select to anon, authenticated using (is_public);

-- 予約 / 顧客 / 監査 / メールログには anon 用ポリシーを作らない (= 読めない)

grant usage on schema public to anon, authenticated;
grant select on aone_settings, aone_categories, aone_holidays, aone_business_days, aone_blocks
  to anon, authenticated;

-- service_role はすべて (RLS はバイパスされる)
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---- 空き状況関数: SECURITY DEFINER で集計だけ公開 ---------------------------
alter function aone_day_state(date)                     security definer set search_path = public, pg_temp;
alter function aone_month_state(integer, integer)       security definer set search_path = public, pg_temp;
alter function aone_check_availability(text, date, text, text, time, time, integer, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_rp_peak_groups(date, time, time, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_live_reservations_in_window(date, time, time, uuid)
                                                        security definer set search_path = public, pg_temp;
alter function aone_blocking_blocks(date, text, text, time, time)
                                                        security definer set search_path = public, pg_temp;

revoke all on function aone_live_reservations_in_window(date, time, time, uuid) from public, anon, authenticated;
revoke all on function aone_rp_peak_groups(date, time, time, uuid) from public, anon, authenticated;

grant execute on function aone_day_state(date) to anon, authenticated, service_role;
grant execute on function aone_month_state(integer, integer) to anon, authenticated, service_role;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid)
  to anon, authenticated, service_role;
grant execute on function aone_is_holiday(date) to anon, authenticated, service_role;
grant execute on function aone_today() to anon, authenticated, service_role;

-- ---- 書き込み RPC: service_role 専用 ----------------------------------------
revoke all on function aone_create_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_update_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_cancel_reservation(jsonb)     from public, anon, authenticated;
revoke all on function aone_set_reservation_status(jsonb) from public, anon, authenticated;
revoke all on function aone_upsert_customer(text, text, text, text) from public, anon, authenticated;

grant execute on function aone_create_reservation(jsonb)     to service_role;
grant execute on function aone_update_reservation(jsonb)     to service_role;
grant execute on function aone_cancel_reservation(jsonb)     to service_role;
grant execute on function aone_set_reservation_status(jsonb) to service_role;
grant execute on function aone_upsert_customer(text, text, text, text) to service_role;

-- 顧客サマリ VIEW も service_role のみ
revoke all on aone_customer_stats from public, anon, authenticated;
grant select on aone_customer_stats to service_role;

-- ###########################################################################
-- # 0006_category_walkin.sql
-- ###########################################################################

-- =============================================================================
-- カテゴリーごとの「予約が必要か」フラグ
-- =============================================================================
-- A-ONE の実運用 (2026-08 オーナー確認):
--   * スポーツ走行の予約が 1 件も無い日でも、**カートとミニバイクは走れる**
--     (飛び込み可。予約なしで来場して走行できる)
--   * **キッズカートとその他 (大型バイク等) は事前予約が必要**
--
-- 「今日走れる？」で全カテゴリーを一律に「走れます」と出すと、キッズで
-- 来場した人が走れない事故になるため、表示を分ける。
--
-- 受付枠 (クラス数) の計算そのものは変えない。飛び込みはシステムに乗らない
-- ので、現場でクラスが埋まったかどうかは A-ONE 側の判断が優先される
-- (仕様 20: 通常ルールは自動判定、最終判断は現場)。
-- =============================================================================

alter table aone_categories
  add column if not exists requires_reservation boolean not null default false;

comment on column aone_categories.requires_reservation is
  'true = 事前予約が必要なカテゴリー。false = 予約なしの飛び込みでも走れる';

update aone_categories set requires_reservation = false where code in ('kart', 'minibike');
update aone_categories set requires_reservation = true  where code in ('kidskart', 'other');

-- 「今日走れる？」で使うので、カテゴリー状態にフラグを含めて返す
create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.weather_status, bd.status_message, bd.staff_note into v_weather
  from aone_business_days bd where bd.date = p_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        if (not coalesce(v_has_cat, false) and coalesce(v_classes, 0) + 1 >= v_limit)
           or v_peak = s.rp_groups_block_sport - 1 then
          v_status := 'limited';
        else
          v_status := 'open';
        end if;
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        -- 予約が必要なカテゴリーか (false = 飛び込みでも走れる)
        'requires_reservation', v_cat.requires_reservation,
        -- 予約なしで今そのまま走れるか
        'walk_in_ok', v_status in ('open','limited')
                      and (not v_cat.requires_reservation or coalesce(v_has_cat, false)),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'weather', jsonb_build_object(
      'status',  coalesce(v_weather.weather_status, 'normal'),
      'message', v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;

alter function aone_day_state(date) security definer set search_path = public, pg_temp;
grant execute on function aone_day_state(date) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0007_sport_no_limited.sql
-- ###########################################################################

-- =============================================================================
-- スポーツ走行の「残りわずか (△)」表示をやめる
-- =============================================================================
-- 2026-08 オーナー指示。
--
-- 利用者が知りたいのは「今日そのカテゴリーで走れるか / 走れないか」だけで、
-- △ (残りわずか) は判断を迷わせるだけだった。カテゴリーの状態は
--   open   ○ 走れます
--   closed ✕ 受付停止 (クラス上限 / RP 飽和 / 貸切)
--   off    — 対象外 (雨天中止 / 終日ブロック / 過去日)
-- の 3 つだけにする。
--
-- 残りクラス数は管理画面の「1 / 2 クラス」で把握できるので情報は失われない。
-- RP の時間枠は従来どおり残り 1 グループを △ で出す (こちらは開始時間を
-- 選ぶ判断材料になるため)。
-- =============================================================================

create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.weather_status, bd.status_message, bd.staff_note into v_weather
  from aone_business_days bd where bd.date = p_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        -- スポーツ走行に「残りわずか (△)」は出さない (2026-08 オーナー指示)。
        -- 利用者が知りたいのは「走れるか / 走れないか」だけで、△ は迷わせるだけ。
        -- 残りクラス数はスタッフが used_classes / max_classes で把握できる。
        v_status := 'open';
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        -- 予約が必要なカテゴリーか (false = 飛び込みでも走れる)
        'requires_reservation', v_cat.requires_reservation,
        -- 予約なしで今そのまま走れるか
        'walk_in_ok', v_status in ('open','limited')
                      and (not v_cat.requires_reservation or coalesce(v_has_cat, false)),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'weather', jsonb_build_object(
      'status',  coalesce(v_weather.weather_status, 'normal'),
      'message', v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;


alter function aone_day_state(date) security definer set search_path = public, pg_temp;
grant execute on function aone_day_state(date) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0008_admin_only_category.sql
-- ###########################################################################

-- =============================================================================
-- 管理画面からのみ予約できるカテゴリー
-- =============================================================================
-- 2026-08 オーナー指示: キッズカートの予約は管理画面からのみ受け付ける。
--
-- キッズカートは車両の準備・インストラクターの手配が要るため、Web から
-- 直接入ってこられると現場が回らない。電話で相談を受けてスタッフが登録する運用。
--
-- 予約フォームには出さないが、
--   * 管理画面の代理入力には出る
--   * 予約が入っている日は「今日走れる？」に表示される (実際に走っているため)
--   * クラス数の判定には従来どおり参加する
-- =============================================================================

alter table aone_categories
  add column if not exists admin_only boolean not null default false;

comment on column aone_categories.admin_only is
  'true = 顧客向け予約フォームには出さない (管理画面からの代理入力のみ)';

update aone_categories set admin_only = true  where code = 'kidskart';
update aone_categories set admin_only = false where code in ('kart', 'minibike', 'other');

create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.weather_status, bd.status_message, bd.staff_note into v_weather
  from aone_business_days bd where bd.date = p_date;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        -- スポーツ走行に「残りわずか (△)」は出さない (2026-08 オーナー指示)。
        -- 利用者が知りたいのは「走れるか / 走れないか」だけで、△ は迷わせるだけ。
        -- 残りクラス数はスタッフが used_classes / max_classes で把握できる。
        v_status := 'open';
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        -- 予約が必要なカテゴリーか (false = 飛び込みでも走れる)
        'requires_reservation', v_cat.requires_reservation,
        -- true = 予約フォームに出さない (管理画面からの代理入力のみ受け付ける)
        'admin_only', v_cat.admin_only,
        -- 予約なしで今そのまま走れるか
        'walk_in_ok', v_status in ('open','limited')
                      and (not v_cat.requires_reservation or coalesce(v_has_cat, false)),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'weather', jsonb_build_object(
      'status',  coalesce(v_weather.weather_status, 'normal'),
      'message', v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;



alter function aone_day_state(date) security definer set search_path = public, pg_temp;
grant execute on function aone_day_state(date) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0009_prices.sql
-- ###########################################################################

-- =============================================================================
-- 料金設定と自動計算 (2026-08 オーナー確認)
-- =============================================================================
-- A-ONE の商品構成
--
--   レンタル (レンタルカートを使うもの)
--     * RP (レースパック)  6,600 円 / 人
--       練習 → 予選 → レース、表彰台で記念撮影あり
--     * 貸切               10,000 円 + 10,000 円 × カート台数 (最小 5 台)
--       → 5 台なら 60,000 円
--       ※ 2026-08 に 11,000 円 + 11,000 円 × 台数 (5 台で 66,000 円) へ改定。
--         現行の金額は 0014_pricing_and_cancel_policy.sql を参照。
--     * 通常のレンタル走行  1 ヒート 2,200 円 / 7 分 … **予約不要**なのでシステムに載せない
--
--   スポーツ走行 (持ち込み車両)
--     カート / ミニバイク / キッズカート / その他
--
-- 料金は予約時に自動計算して aone_reservations.amount に入れる。
-- 現地払いが前提 (仕様 18) なので決済はしないが、予約画面とメールに金額を出し、
-- 管理画面の会計記録にも使う。
-- 金額を変えるときは /admin/settings から。コードは触らない。
-- =============================================================================

alter table aone_settings
  add column if not exists rp_price_per_person    integer  not null default 6600,
  add column if not exists charter_base_price     integer  not null default 10000,
  add column if not exists charter_price_per_kart integer  not null default 10000,
  add column if not exists charter_min_karts      smallint not null default 5,
  add column if not exists rental_heat_price      integer  not null default 2200,
  add column if not exists rental_heat_minutes    smallint not null default 7,
  -- 持ち込み (スポーツ走行) の料金案内。金額体系が違うので文章で持つ
  add column if not exists sport_price_note       text;

-- -----------------------------------------------------------------------------
-- 金額の自動計算
-- -----------------------------------------------------------------------------
-- amount が未指定のときだけ入れる。スタッフが管理画面で個別の金額を入れた場合や、
-- 特別対応で値引きした場合はその値を尊重する (仕様 20: 現場判断が優先)。
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
declare
  s     aone_settings%rowtype;
  karts integer;
begin
  if new.amount is not null then
    return new;
  end if;

  select * into s from aone_settings where id = 1;

  if new.kind = 'rp' then
    new.amount := coalesce(new.party_size, 0) * s.rp_price_per_person;

  elsif new.kind = 'charter' then
    -- 台数未指定なら最小台数で見積もる (確定時にスタッフが直す)
    karts := greatest(coalesce(new.vehicle_count, s.charter_min_karts), s.charter_min_karts);
    new.amount := s.charter_base_price + s.charter_price_per_kart * karts;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

-- ###########################################################################
-- # 0010_calendar_colors_and_rp_names.sql
-- ###########################################################################

-- =============================================================================
-- カテゴリーの色分け と RP 予約者名の公開設定
-- =============================================================================
-- 1. 管理カレンダーでスポーツ走行をカテゴリー別に色分けするための色を持たせる。
--    将来ポケバイ・モタード等を足しても、色をここで決めれば画面に反映される。
--
-- 2. 予約画面 (顧客向け RP) に「すでに入っている予約の時間と名前」を出す。
--    旧スケジュールページ (WordPress) が「AM10:00〜 RP パットリ様」と
--    実名を公開していた運用に合わせる。ただし公開範囲は選べるようにする:
--      full   … 入力されたお名前をそのまま (山田太郎 様)
--      family … 姓だけ (山田 様)   ← 既定
--      hidden … 名前は出さず時間だけ
--    スタッフ向けの管理画面は従来どおりフルネームを表示する。
-- =============================================================================

alter table aone_categories
  add column if not exists color text not null default '#6d8095';

comment on column aone_categories.color is '管理カレンダーでの表示色 (CSS カラー)';

update aone_categories set color = '#0f8a8a' where code = 'kart';      -- 青緑
update aone_categories set color = '#1e9e62' where code = 'minibike';  -- 緑
update aone_categories set color = '#f5a623' where code = 'kidskart';  -- オレンジ
update aone_categories set color = '#6d8095' where code = 'other';     -- グレー

alter table aone_settings
  add column if not exists public_name_display text not null default 'family';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'aone_settings_public_name_display_chk'
  ) then
    alter table aone_settings
      add constraint aone_settings_public_name_display_chk
      check (public_name_display in ('full', 'family', 'hidden'));
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 公開用の表示名
-- -----------------------------------------------------------------------------
-- 「山田 太郎」→「山田」、空白が無い「山田太郎」→ 先頭 2 文字「山田」。
-- 日本語の姓は 2 文字が最も多いので既定はこれ。3 文字姓 (佐々木 等) は
-- 「佐々様」になってしまうため、正確さが要るなら full を選ぶ運用にする。
create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  select case
    when p_mode = 'hidden' then null
    when p_mode = 'full'   then trim(p_name) || ' 様'
    when position(' ' in trim(p_name)) > 0 or position('　' in trim(p_name)) > 0
      then split_part(replace(trim(p_name), '　', ' '), ' ', 1) || ' 様'
    when length(trim(p_name)) <= 3 then trim(p_name) || ' 様'
    else left(trim(p_name), 2) || ' 様'
  end;
$$;

-- -----------------------------------------------------------------------------
-- ある日の RP 予約一覧 (公開用)
-- -----------------------------------------------------------------------------
-- 返すのは開始時間・人数・表示名だけ。電話番号やメールは絶対に返さない。
create or replace function aone_rp_day_bookings(p_date date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'time', to_char(r.start_time, 'HH24:MI'),
           'party_size', r.party_size,
           'name', aone_public_name(r.contact_name, s.public_name_display),
           'status', r.status
         ) order by r.start_time), '[]'::jsonb)
  from aone_reservations r, aone_settings s
  where s.id = 1
    and r.date = p_date
    and r.kind = 'rp'
    and aone_is_live(r.status);
$$;

grant execute on function aone_rp_day_bookings(date) to anon, authenticated, service_role;
grant execute on function aone_public_name(text, text) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0011_month_categories.sql
-- ###########################################################################

-- =============================================================================
-- 月カレンダーにカテゴリー別の走行可否を持たせる
-- =============================================================================
-- 「前 ○ / 後 ○」だけでは、カートが走れるのかミニバイクが走れるのかが
-- 利用者に分からなかった。月表示にもカテゴリーごとの状態を持たせて、
-- 「前 カート・ミニバイク」のように何が走れるかを出せるようにする。
--
-- 返すのは集計だけ。予約者名は公開カレンダーには一切出さない。
-- =============================================================================

create or replace function aone_month_state(p_year integer, p_month integer) returns jsonb
language sql stable as $$
  with days as (
    select generate_series(
      make_date(p_year, p_month, 1),
      (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
      interval '1 day')::date as d
  ),
  -- MATERIALIZED が必須: 付けないと下で st を参照するたびに
  -- aone_day_state() が再評価され、1 か月ぶんで数秒かかる。
  states as materialized (
    select d, aone_day_state(d) as st from days
  )
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'),
      'dow', extract(dow from d)::int,
      'is_holiday', st->>'is_holiday' = 'true',
      'weather', st->'weather'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
      -- カテゴリーごとの状態 (何が走れるかを出すため)
      'am_categories', st->'sport'->'am'->'categories',
      'pm_categories', st->'sport'->'pm'->'categories',
      'rp_free', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                   where (s->>'accepting')::boolean),
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                          'title', b->>'title',
                          'public_label', b->>'public_label',
                          'kind', b->>'kind',
                          'is_public', (b->>'is_public')::boolean)), '[]'::jsonb)
                 from jsonb_array_elements(st->'blocks') b),
      'counts', st->'counts'
    ) as x
    from states
  ) y;
$$;

alter function aone_month_state(integer, integer) security definer set search_path = public, pg_temp;
grant execute on function aone_month_state(integer, integer) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0012_rental_bookings_public.sql
-- ###########################################################################

-- =============================================================================
-- 公開カレンダーに RP・貸切の予約 (時間 + 名前) を出す
-- =============================================================================
-- 旧 WordPress スケジュールが「AM10:00〜 RP パットリ様」「貸切午前」と
-- 出していた運用に合わせる。公開するのは
--   種別 (RP / 貸切) ・時間・人数・表示名
-- だけで、電話番号やメールは返さない。
--
-- 名前の粒度は aone_settings.public_name_display で切り替える
-- (family: 姓のみ / full: 入力どおり / hidden: 名前を出さない)。
-- hidden にすれば「10:00 RP 5名」のように名前なしで出る。
--
-- あわせて敬称の二重付けを直す。スタッフが「クオ様」と入力した予約が
-- 「クオ様 様」と表示されていた。
-- =============================================================================

-- 末尾の敬称を落とす (様 / さま / サマ / さん / 御中)
create or replace function aone_strip_honorific(p_name text) returns text
language sql immutable as $$
  select nullif(trim(regexp_replace(trim(coalesce(p_name, '')),
    '(様|さま|サマ|さん|サン|御中)\s*$', '')), '');
$$;

create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  with n as (select coalesce(aone_strip_honorific(p_name), trim(coalesce(p_name, ''))) as v)
  select case
    when p_mode = 'hidden' then null
    when (select v from n) = '' then null
    when p_mode = 'full' then (select v from n) || ' 様'
    when position(' ' in (select v from n)) > 0 or position('　' in (select v from n)) > 0
      then split_part(replace((select v from n), '　', ' '), ' ', 1) || ' 様'
    when length((select v from n)) <= 3 then (select v from n) || ' 様'
    else left((select v from n), 2) || ' 様'
  end;
$$;

-- -----------------------------------------------------------------------------
-- 期間内の RP・貸切の予約 (公開用)
-- -----------------------------------------------------------------------------
-- 日付をキーにした jsonb オブジェクトで返す: { "2026-09-02": [ {...}, ... ] }
create or replace function aone_rental_bookings(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(d, items), '{}'::jsonb)
  from (
    select to_char(r.date, 'YYYY-MM-DD') as d,
           jsonb_agg(jsonb_build_object(
             'kind', r.kind,
             'time', to_char(r.start_time, 'HH24:MI'),
             'end_time', to_char(r.end_time, 'HH24:MI'),
             'party_size', r.party_size,
             -- 貸切は団体名が入るので略さない (「麻生工科大学」→「麻生」では困る)。
             -- 名前を出さない設定のときだけ null にする。
             'name', case
               when r.kind = 'charter'
                 then aone_public_name(r.contact_name,
                        case when s.public_name_display = 'hidden' then 'hidden' else 'full' end)
               else aone_public_name(r.contact_name, s.public_name_display)
             end
           ) order by r.start_time) as items
    from aone_reservations r, aone_settings s
    where s.id = 1
      and r.date between p_from and p_to
      and r.kind in ('rp', 'charter')
      and aone_is_live(r.status)
    group by r.date
  ) t;
$$;

grant execute on function aone_rental_bookings(date, date) to anon, authenticated, service_role;
grant execute on function aone_strip_honorific(text) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0013_night_rental_only.sql
-- ###########################################################################

-- =============================================================================
-- ナイターは「レースパック」か「貸切」のみ (2026-08 オーナー指示)
-- =============================================================================
-- ナイター走行はレンタルカートの商品としてのみ提供する。
-- 持ち込み (スポーツ走行) のナイターは受け付けない。
--
-- ナイターは従来どおり要相談 (status = checking) で受け、A-ONE が折り返す。
-- 通常営業時間外なので自動判定はしない。
--
-- 料金も RP / 貸切と同じ計算で入れる:
--   RP   … 人数 × 単価
--   貸切 … 基本料 + 台数 × 単価 (最小台数を下回らない)
-- =============================================================================

alter table aone_reservations
  add column if not exists night_kind text
  constraint aone_res_night_kind_chk check (night_kind is null or night_kind in ('rp', 'charter'));

comment on column aone_reservations.night_kind is
  'ナイターの内訳。rp = レースパック / charter = 貸切';

-- 料金計算: ナイターも内訳に応じて金額を入れる
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
declare
  s     aone_settings%rowtype;
  karts integer;
  v_as  text;   -- 料金計算上の種別 (ナイターは night_kind を使う)
begin
  if new.amount is not null then
    return new;
  end if;

  select * into s from aone_settings where id = 1;

  v_as := case when new.kind = 'night' then new.night_kind else new.kind end;

  if v_as = 'rp' then
    new.amount := coalesce(new.party_size, 0) * s.rp_price_per_person;

  elsif v_as = 'charter' then
    -- 台数未指定なら最小台数で見積もる (確定時にスタッフが直す)
    karts := greatest(coalesce(new.vehicle_count, s.charter_min_karts), s.charter_min_karts);
    new.amount := s.charter_base_price + s.charter_price_per_kart * karts;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

-- 予約作成 RPC に night_kind を通す (それ以外は 0004 と同じ)
create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null);

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code, night_kind,
    party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    nullif(payload->>'night_kind', ''),
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', '')
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'night_kind', v_row.night_kind,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

-- ###########################################################################
-- # 0014_pricing_and_cancel_policy.sql
-- ###########################################################################

-- =============================================================================
-- 貸切料金の改定とキャンセル規定の変更 (2026-08 オーナー確認)
-- =============================================================================
-- 1. 貸切
--      旧: 10,000 円 + 10,000 円 × カート台数 (最小 5 台) = 5 台で 60,000 円
--      新: 11,000 円 + 11,000 円 × カート台数 (最小 5 台) = 5 台で 66,000 円
--
-- 2. キャンセル規定
--      旧: RP・貸切は開始 24 時間前以降のキャンセルで料金 100%
--      新: **当日・ご連絡のないキャンセル (無断キャンセル) のみ料金 100%**
--          連絡さえあれば、当日でも・種別を問わずキャンセル料なし。
--
--    → キャンセル料フラグは「無断キャンセルとして処理したかどうか」だけで決まる。
--      お客様が専用ページから自分でキャンセルした場合は連絡があった扱いなので、
--      当日でもキャンセル料は発生しない。
--
--    aone_settings.rp_cancel_deadline_hours は使わなくなったが、列は残す
--    (過去の予約の監査ログに残っている値の意味を保つため)。
-- =============================================================================

-- 1. 貸切料金 -----------------------------------------------------------------
alter table aone_settings
  alter column charter_base_price     set default 11000,
  alter column charter_price_per_kart set default 11000;

-- 旧価格のままの場合だけ更新する (管理画面で別の額に変えていたら尊重する)
update aone_settings set charter_base_price     = 11000
  where id = 1 and charter_base_price = 10000;
update aone_settings set charter_price_per_kart = 11000
  where id = 1 and charter_price_per_kart = 10000;

-- 2. キャンセル規定 -----------------------------------------------------------
-- payload: { access_token | id, reason?, actor?, no_show? }
--
-- キャンセル自体は常に受け付けて、料金発生フラグ (cancel_fee) を返す方針は
-- 変えない (現場で個別対応できるようにするため — 仕様 20)。
create or replace function aone_cancel_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row     aone_reservations%rowtype;
  v_no_show boolean := coalesce((payload->>'no_show')::boolean, false);
begin
  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status,
                              'already', true, 'cancel_fee', false);
  end if;

  update aone_reservations set
    status        = case when v_no_show then 'no_show' else 'cancelled' end,
    cancelled_at  = now(),
    cancel_reason = nullif(payload->>'reason', ''),
    cancelled_by  = coalesce(nullif(payload->>'actor', ''), 'customer')
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_no_show then 'no_show' else 'cancelled' end,
          coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('reason', payload->>'reason', 'cancel_fee', v_no_show));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    -- 無断キャンセルのときだけ料金 100%
    'cancel_fee', v_no_show
  );
end;
$$;

revoke all on function aone_cancel_reservation(jsonb) from public;
grant execute on function aone_cancel_reservation(jsonb) to service_role;

-- ###########################################################################
-- # 0015_callback_tracking.sql
-- ###########################################################################

-- =============================================================================
-- 折り返し対応の記録と、放置の検知 (2026-08 オーナー要望)
-- =============================================================================
-- 「連絡待ち (contact_wait)」「確認中 (checking)」の予約は、A-ONE から
-- 折り返さない限り確定しない。ここを落とすと機会損失に直結するため、
--
--   1. 誰がいつ・どの手段で対応したかを記録する (対応済みボタン)
--   2. 受付から一定時間たっても未対応のものを検知できるようにする
--
-- 「対応済み」はステータスとは別に持つ。電話はしたが返事待ち、という
-- 状態があるため (対応済み = 確定ではない)。確定・キャンセルは今までどおり
-- ステータスで表す。
-- =============================================================================

alter table aone_reservations
  add column if not exists contacted_at     timestamptz,
  add column if not exists contacted_by     text,
  add column if not exists contact_method   text
    check (contact_method is null or contact_method in ('phone', 'email', 'line', 'counter', 'other')),
  add column if not exists contact_result   text;

comment on column aone_reservations.contacted_at is
  '折り返し対応をした日時。null = まだ折り返していない';

-- 未対応の抽出を速くする (件数は少ないが毎日の cron で引く)
create index if not exists aone_res_pending_callback_idx
  on aone_reservations (status, contacted_at)
  where status in ('contact_wait', 'checking');

-- -----------------------------------------------------------------------------
-- 対応済みにする
-- -----------------------------------------------------------------------------
-- payload: { id, method?, result?, actor?, undo? }
--   method … phone / email / line / counter / other
--   result … 対応内容のメモ (「留守電」「日程調整中」など)
--   undo   … true なら対応記録を取り消す (押し間違いの取り消し用)
create or replace function aone_mark_contacted(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row  aone_reservations%rowtype;
  v_undo boolean := coalesce((payload->>'undo')::boolean, false);
begin
  select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;

  update aone_reservations set
    contacted_at   = case when v_undo then null else now() end,
    contacted_by   = case when v_undo then null else coalesce(nullif(payload->>'actor', ''), 'admin') end,
    contact_method = case when v_undo then null else nullif(payload->>'method', '') end,
    contact_result = case when v_undo then null else nullif(payload->>'result', '') end
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_undo then 'contact_undone' else 'contacted' end,
          coalesce(nullif(payload->>'actor', ''), 'admin'),
          jsonb_build_object('method', payload->>'method', 'result', payload->>'result'));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'contacted_at', v_row.contacted_at,
    'contact_method', v_row.contact_method
  );
end;
$$;

revoke all on function aone_mark_contacted(jsonb) from public;
grant execute on function aone_mark_contacted(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 折り返し待ちのまま放置されている予約
-- -----------------------------------------------------------------------------
-- p_hours 時間以上たっても対応記録が無いものを、古い順に返す。
-- 管理画面の警告表示と、毎朝の cron メールの両方で使う。
create or replace function aone_pending_callbacks(p_hours integer default 24)
returns table (
  id                 uuid,
  reservation_number text,
  kind               text,
  status             text,
  date               date,
  start_time         time,
  end_time           time,
  party_size         integer,
  contact_name       text,
  contact_phone      text,
  contact_email      text,
  request_note       text,
  created_at         timestamptz,
  hours_waiting      integer
)
language sql stable as $$
  select r.id, r.reservation_number, r.kind, r.status, r.date,
         r.start_time, r.end_time, r.party_size,
         r.contact_name, r.contact_phone, r.contact_email, r.request_note,
         r.created_at,
         floor(extract(epoch from (now() - r.created_at)) / 3600)::int
  from aone_reservations r
  where r.status in ('contact_wait', 'checking')
    and r.contacted_at is null
    -- <= にしているのは、同一トランザクション内では now() が固定で
    -- created_at と同値になり、p_hours = 0 のテストが通らなくなるため
    and r.created_at <= now() - make_interval(hours => greatest(p_hours, 0))
  order by r.created_at;
$$;

revoke all on function aone_pending_callbacks(integer) from public;
grant execute on function aone_pending_callbacks(integer) to service_role;

-- ###########################################################################
-- # 0016_amount_on_update.sql
-- ###########################################################################

-- =============================================================================
-- 人数・台数を変更したときに金額を計算し直す
-- =============================================================================
-- これまで金額は INSERT 時にしか計算していなかったため、
--   RP 3 名 (19,800 円) → 5 名に変更  … 19,800 円のまま
--   貸切 5 台 (66,000 円) → 8 台に変更 … 66,000 円のまま
-- になっていた。予約完了メールと変更のお知らせメールに金額を載せるように
-- したので、ここがズレると請求の食い違いになる。
--
-- 現場で値引きした金額 (手入力) は尊重する。判定は
-- 「変更前の金額が、変更前の内容から自動計算した額と一致しているか」で行う。
-- 一致していれば自動計算のままなので追従させ、違えば手で入れた額なので触らない。
-- 会計済み (is_paid) のものも触らない。
-- =============================================================================

-- 料金計算の本体。INSERT 時の埋め込みと UPDATE 時の再計算で共用する
-- (同じ式を 2 か所に書くと必ずズレるため)
create or replace function aone_auto_amount(
  p_kind       text,
  p_night_kind text,
  p_party      integer,
  p_vehicles   integer
) returns integer
language plpgsql stable as $$
declare
  s     aone_settings%rowtype;
  karts integer;
  v_as  text;
begin
  select * into s from aone_settings where id = 1;

  -- ナイターは中身 (RP / 貸切) の料金で計算する
  v_as := case when p_kind = 'night' then p_night_kind else p_kind end;

  if v_as = 'rp' then
    return coalesce(p_party, 0) * s.rp_price_per_person;
  elsif v_as = 'charter' then
    -- 台数未指定なら最小台数で見積もる (確定時にスタッフが直す)
    karts := greatest(coalesce(p_vehicles, s.charter_min_karts), s.charter_min_karts);
    return s.charter_base_price + s.charter_price_per_kart * karts;
  end if;

  return null;  -- スポーツ走行は料金体系が違うので入れない
end;
$$;

create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
begin
  if new.amount is not null then
    return new;
  end if;
  new.amount := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);
  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

-- -----------------------------------------------------------------------------
-- 変更時の再計算
-- -----------------------------------------------------------------------------
create or replace function aone_recalc_amount() returns trigger
language plpgsql as $$
declare
  v_old_auto integer;
  v_new_auto integer;
begin
  -- 会計済みは触らない
  if new.is_paid then
    return new;
  end if;
  -- 金額そのものを書き換える更新 (管理画面の手入力) は尊重する
  if new.amount is distinct from old.amount then
    return new;
  end if;
  -- 計算に効く項目が変わっていなければ何もしない
  if new.party_size is not distinct from old.party_size
     and new.vehicle_count is not distinct from old.vehicle_count
     and new.kind is not distinct from old.kind
     and new.night_kind is not distinct from old.night_kind then
    return new;
  end if;

  v_old_auto := aone_auto_amount(old.kind, old.night_kind, old.party_size, old.vehicle_count);
  v_new_auto := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);

  -- 変更前が自動計算のままだったときだけ追従させる
  if v_new_auto is not null and old.amount is not distinct from v_old_auto then
    new.amount := v_new_auto;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_recalc_amount on aone_reservations;
create trigger aone_res_recalc_amount before update on aone_reservations
  for each row execute function aone_recalc_amount();

-- ###########################################################################
-- # 0017_amount_manual_flag.sql
-- ###########################################################################

-- =============================================================================
-- 金額を「手入力したかどうか」で持つ
-- =============================================================================
-- 0016 では「変更前の金額が、変更前の内容から自動計算した額と一致するか」で
-- 手入力かどうかを判定していた。この方法だと、何らかの理由で一度ズレた行は
-- 以後ずっと「手入力された金額」と誤判定され、二度と再計算されない。
--
--   例) 0016 を入れる前に 3 名 → 5 名に変更した予約
--       金額は 19,800 円のまま (5 名の自動計算は 33,000 円)
--       → 以後どれだけ人数を変えても 19,800 円から動かない
--
-- 判定を推測ではなく事実で持つように変える。金額を明示的に書き換えたときに
-- amount_manual を立て、立っていない限りは常に自動計算に追従させる。
-- 既存行は既定値 false なので、次に何か変更した時点で正しい金額に直る。
--
-- 現場で値引きした金額は、管理画面から金額を入力した時点で amount_manual が
-- 立つので、これまでどおり尊重される。
-- =============================================================================

alter table aone_reservations
  add column if not exists amount_manual boolean not null default false;

comment on column aone_reservations.amount_manual is
  '金額を手で入力したか。true の間は人数・台数を変えても自動計算で上書きしない';

-- 作成時に金額を指定していたものは手入力扱いにする
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
begin
  if new.amount is not null then
    new.amount_manual := true;   -- 明示的に渡された金額は尊重する
    return new;
  end if;
  new.amount := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);
  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

create or replace function aone_recalc_amount() returns trigger
language plpgsql as $$
declare
  v_auto integer;
begin
  -- 金額そのものを書き換える更新 = 手入力。以後は自動計算で上書きしない
  if new.amount is distinct from old.amount then
    new.amount_manual := true;
    return new;
  end if;

  -- 手入力された金額と、会計済みのものは触らない
  if new.amount_manual or new.is_paid then
    return new;
  end if;

  -- ここまで来たら自動計算のままの行。常に現在の内容から計算し直す
  -- (人数を変えていない更新でも、過去にズレていれば直る)
  v_auto := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);
  if v_auto is not null then
    new.amount := v_auto;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_recalc_amount on aone_reservations;
create trigger aone_res_recalc_amount before update on aone_reservations
  for each row execute function aone_recalc_amount();

-- -----------------------------------------------------------------------------
-- 既にズレている行をこの場で直す
-- -----------------------------------------------------------------------------
-- 0016 より前に人数・台数を変えた予約が対象。まだ運用開始前なので、
-- 自動計算のままだったものは正しい金額に揃えてしまう。
update aone_reservations r set amount = aone_auto_amount(r.kind, r.night_kind, r.party_size, r.vehicle_count)
where not r.amount_manual
  and not r.is_paid
  and aone_auto_amount(r.kind, r.night_kind, r.party_size, r.vehicle_count) is not null
  and r.amount is distinct from aone_auto_amount(r.kind, r.night_kind, r.party_size, r.vehicle_count);

-- ###########################################################################
-- # 0018_amount_manual_fix.sql
-- ###########################################################################

-- =============================================================================
-- 「金額を書き換えた = 手入力」の判定を絞る
-- =============================================================================
-- 0017 のトリガーは「金額が変わった UPDATE」をすべて手入力とみなしていた。
-- そのため 0017 自身の一括修正 (ズレていた金額を自動計算に揃える UPDATE) が
-- トリガーを踏み、直した行がすべて amount_manual = true になってしまった。
-- 直したのに以後追従しなくなる、という 0016 と同じ結末になる。
--
-- 手入力とみなすのは「自動計算と違う金額を入れたとき」だけにする。
--   ・自動計算と同じ額を入れた   → 手入力として記録する意味がない
--   ・自動計算と違う額を入れた   → 値引き等の意図がある = 手入力
-- こうすると、自動計算に揃える UPDATE ではフラグが立たない。
-- =============================================================================

create or replace function aone_recalc_amount() returns trigger
language plpgsql as $$
declare
  v_auto integer;
begin
  v_auto := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);

  -- 自動計算と違う金額を入れた = 値引き等の意図がある。以後は上書きしない
  if new.amount is distinct from old.amount
     and new.amount is distinct from v_auto then
    new.amount_manual := true;
    return new;
  end if;

  -- 手入力された金額と、会計済みのものは触らない
  if new.amount_manual or new.is_paid then
    return new;
  end if;

  -- 自動計算のままの行。常に現在の内容から計算し直す
  if v_auto is not null then
    new.amount := v_auto;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_recalc_amount on aone_reservations;
create trigger aone_res_recalc_amount before update on aone_reservations
  for each row execute function aone_recalc_amount();

-- -----------------------------------------------------------------------------
-- 0017 が誤って立てたフラグを下ろす
-- -----------------------------------------------------------------------------
-- 金額が自動計算と一致している行は、手入力として記録する理由がない。
-- 値引きした金額 (自動計算と違う額) はフラグを残す。
update aone_reservations r set amount_manual = false
where r.amount_manual
  and not r.is_paid
  and r.amount is not distinct from
      aone_auto_amount(r.kind, r.night_kind, r.party_size, r.vehicle_count);

-- ###########################################################################
-- # 0019_charter_and_same_day_rules.sql
-- ###########################################################################

-- =============================================================================
-- 貸切と当日 RP の受付制限 (2026-08 オーナー確認)
-- =============================================================================
--   * 貸切はカート 4 台以下では受け付けない (最小 5 台)
--   * 貸切は当日の申込を受け付けない (前日まで)
--   * 当日の RP は 17:00 以降の開始を受け付けない
--   * 当日の RP は 2 時間後以降のお時間のみ
--
-- いずれも aone_check_availability() に入れる。ここに入れておけば、
-- Web の予約フォーム・管理画面・予約者ページの変更のすべてで同じ判定になり、
-- 管理者は forced = true で従来どおり上書きできる。
--
-- 台数を見る必要があるので p_vehicles を足す。既存の 8 引数の呼び出しは
-- 既定値 null で通るが、同名 8 引数の関数が残っていると呼び分けが起きるため
-- 先に drop する。
-- =============================================================================

alter table aone_settings
  add column if not exists charter_min_lead_days    smallint not null default 1,
  add column if not exists rp_same_day_lead_minutes smallint not null default 120,
  add column if not exists rp_same_day_last_start   time     not null default '17:00';

comment on column aone_settings.charter_min_lead_days is
  '貸切を何日前までに申し込む必要があるか。1 = 前日まで (当日不可)';
comment on column aone_settings.rp_same_day_lead_minutes is
  '当日の RP を今から何分後以降で受けるか';
comment on column aone_settings.rp_same_day_last_start is
  '当日の RP の開始上限。この時刻以降は受け付けない (17:00 なら 16:30 が最終)';

drop function if exists aone_check_availability(text, date, text, text, time, time, integer, uuid);

create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null   -- 貸切のカート台数
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 天候による営業状態 (仕様 8)
  select weather_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', '本日は雨天中止です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 当日の RP は準備とスタッフの都合で制限がきびしい (2026-08 オーナー確認)
    if p_date = aone_today() then
      if p_start >= s.rp_same_day_last_start then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_late',
          'message', '本日のレースパックは ' || to_char(s.rp_same_day_last_start, 'HH24:MI')
            || ' より前の開始のみ承ります。お電話でご相談ください');
      end if;
      if ((p_date + p_start) at time zone 'Asia/Tokyo')
           < now() + make_interval(mins => s.rp_same_day_lead_minutes) then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_too_soon',
          'message', '本日のレースパックは ' || (s.rp_same_day_lead_minutes / 60)
            || ' 時間後以降のお時間でご予約ください。お急ぎの場合はお電話ください',
          'detail', jsonb_build_object('lead_minutes', s.rp_same_day_lead_minutes));
      end if;
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 当日の貸切は受けない (カートの準備が要る / 2026-08 オーナー確認)
    if p_date < aone_today() + s.charter_min_lead_days then
      return jsonb_build_object('ok', false, 'reason', 'charter_lead_time',
        'message', case when s.charter_min_lead_days = 1
          then '貸切は前日までのお申し込みとなります。当日はお電話でご相談ください'
          else '貸切は ' || s.charter_min_lead_days || ' 日前までのお申し込みとなります' end,
        'detail', jsonb_build_object('lead_days', s.charter_min_lead_days));
    end if;

    -- 最小台数を下回る申込は受けない
    if coalesce(p_vehicles, s.charter_min_karts) < s.charter_min_karts then
      return jsonb_build_object('ok', false, 'reason', 'charter_min_karts',
        'message', '貸切はカート ' || s.charter_min_karts || ' 台以上から承ります',
        'detail', jsonb_build_object('karts', p_vehicles, 'min', s.charter_min_karts));
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 台数を判定に渡す (それ以外は 0013 / 0004 と同じ)
-- -----------------------------------------------------------------------------
create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null,
    nullif(payload->>'vehicle_count', '')::int);

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code, night_kind,
    party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    nullif(payload->>'night_kind', ''),
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', '')
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'night_kind', v_row.night_kind,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

create or replace function aone_update_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s        aone_settings%rowtype;
  v_row    aone_reservations%rowtype;
  v_before jsonb;
  v_date   date;
  v_start  time;
  v_end    time;
  v_sess   text;
  v_cat    text;
  v_party  integer;
  v_forced boolean := coalesce((payload->>'forced')::boolean, false);
  v_check  jsonb;
  v_status text;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    raise exception 'この予約は既にキャンセルされています' using errcode = 'AONE1', hint = 'already_cancelled';
  end if;

  v_before := to_jsonb(v_row);

  v_date  := coalesce(nullif(payload->>'date', '')::date, v_row.date);
  v_sess  := coalesce(nullif(payload->>'session', ''), v_row.session);
  v_cat   := coalesce(nullif(payload->>'category_code', ''), v_row.category_code);
  v_party := coalesce(nullif(payload->>'party_size', '')::int, v_row.party_size);
  v_start := coalesce(nullif(payload->>'start_time', '')::time, v_row.start_time);
  v_end   := nullif(payload->>'end_time', '')::time;

  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  if v_row.kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;
  elsif v_row.kind = 'rp' then
    v_end := coalesce(v_end, (v_start + make_interval(mins => s.rp_duration_minutes))::time);
  else
    v_end := coalesce(v_end, v_row.end_time);
  end if;

  -- 自分自身を除外して再判定 (仕様 4: 変更時に最新の空き状況を再判定)
  v_check := aone_check_availability(
    v_row.kind, v_date, v_cat, v_sess,
    case when v_row.kind = 'sport' then null else v_start end,
    case when v_row.kind = 'sport' then null else v_end end,
    v_party, v_row.id,
    coalesce(nullif(payload->>'vehicle_count', '')::int, v_row.vehicle_count));

  if not (v_check->>'ok')::boolean and not v_forced then
    raise exception '%', v_check->>'message'
      using errcode = 'AONE1', hint = v_check->>'reason';
  end if;

  -- 確定済みの予約は、変更後も確定のまま維持する (要相談枠に落ちた場合を除く)
  v_status := case
    when v_row.status in ('confirmed', 'completed') and (v_check->>'status') = 'checking'
      then 'checking'
    else v_row.status
  end;

  update aone_reservations set
    date          = v_date,
    session       = v_sess,
    category_code = v_cat,
    start_time    = v_start,
    end_time      = v_end,
    party_size    = v_party,
    vehicle_count = coalesce(nullif(payload->>'vehicle_count', '')::int, vehicle_count),
    status        = v_status,
    contact_name  = coalesce(nullif(trim(payload->'contact'->>'name'), ''), contact_name),
    contact_kana  = coalesce(nullif(trim(payload->'contact'->>'kana'), ''), contact_kana),
    contact_phone = coalesce(nullif(trim(payload->'contact'->>'phone'), ''), contact_phone),
    contact_email = coalesce(nullif(lower(trim(payload->'contact'->>'email')), ''), contact_email),
    request_note  = coalesce(nullif(payload->>'request_note', ''), request_note),
    staff_memo    = coalesce(nullif(payload->>'staff_memo', ''), staff_memo),
    amount        = coalesce(nullif(payload->>'amount', '')::int, amount),
    forced        = forced or (v_forced and not (v_check->>'ok')::boolean)
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'updated', coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('before', v_before - 'access_token', 'check', v_check));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

revoke all on function aone_create_reservation(jsonb) from public, anon, authenticated;
revoke all on function aone_update_reservation(jsonb) from public, anon, authenticated;
grant execute on function aone_create_reservation(jsonb) to service_role;
grant execute on function aone_update_reservation(jsonb) to service_role;

-- ###########################################################################
-- # 0020_charter_course_only.sql
-- ###########################################################################

-- =============================================================================
-- 貸切のメニューを 2 つに分ける (2026-08 オーナー確認)
-- =============================================================================
--   with_karts  … レンタルカート付き。従来どおり 11,000 円 + 11,000 円 × 台数
--   course_only … コース貸切のみ。内容で料金が変わるため
--                 **金額を出さず、必ず折り返しご連絡する** (status = checking)
--
-- コースのみの貸切は台数の概念が無いので、最小台数のルールは適用しない。
-- 当日不可のルールは両方に効かせる (準備が要るのは同じ)。
-- =============================================================================

alter table aone_reservations
  add column if not exists charter_type text
    check (charter_type is null or charter_type in ('with_karts', 'course_only'));

comment on column aone_reservations.charter_type is
  '貸切の種別。with_karts = レンタルカート付き / course_only = コースのみ (要見積り)';

-- 既存の貸切はすべてレンタルカート付き
update aone_reservations set charter_type = 'with_karts'
where kind = 'charter' and charter_type is null;

-- -----------------------------------------------------------------------------
-- 金額: コースのみの貸切は自動計算しない
-- -----------------------------------------------------------------------------
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
begin
  if new.amount is not null then
    new.amount_manual := true;
    return new;
  end if;
  -- コースのみの貸切は都度見積り。スタッフが金額を入れるまで空のままにする
  if new.charter_type = 'course_only' then
    return new;
  end if;
  new.amount := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);
  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

create or replace function aone_recalc_amount() returns trigger
language plpgsql as $$
declare
  v_auto integer;
begin
  -- コースのみの貸切は自動計算の対象外。入れた金額をそのまま尊重する
  if new.charter_type = 'course_only' then
    if new.amount is distinct from old.amount and new.amount is not null then
      new.amount_manual := true;
    end if;
    return new;
  end if;

  v_auto := aone_auto_amount(new.kind, new.night_kind, new.party_size, new.vehicle_count);

  -- 自動計算と違う金額を入れた = 値引き等の意図がある。以後は上書きしない
  if new.amount is distinct from old.amount
     and new.amount is distinct from v_auto then
    new.amount_manual := true;
    return new;
  end if;

  if new.amount_manual or new.is_paid then
    return new;
  end if;

  if v_auto is not null then
    new.amount := v_auto;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_recalc_amount on aone_reservations;
create trigger aone_res_recalc_amount before update on aone_reservations
  for each row execute function aone_recalc_amount();

-- -----------------------------------------------------------------------------
-- 受付判定に貸切の種別を渡す
-- -----------------------------------------------------------------------------
drop function if exists aone_check_availability(text, date, text, text, time, time, integer, uuid, integer);

create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null,  -- 貸切のカート台数
  p_charter  text default null      -- 貸切の種別 (with_karts / course_only)
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 天候による営業状態 (仕様 8)
  select weather_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', '本日は雨天中止です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 当日の RP は準備とスタッフの都合で制限がきびしい (2026-08 オーナー確認)
    if p_date = aone_today() then
      if p_start >= s.rp_same_day_last_start then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_late',
          'message', '本日のレースパックは ' || to_char(s.rp_same_day_last_start, 'HH24:MI')
            || ' より前の開始のみ承ります。お電話でご相談ください');
      end if;
      if ((p_date + p_start) at time zone 'Asia/Tokyo')
           < now() + make_interval(mins => s.rp_same_day_lead_minutes) then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_too_soon',
          'message', '本日のレースパックは ' || (s.rp_same_day_lead_minutes / 60)
            || ' 時間後以降のお時間でご予約ください。お急ぎの場合はお電話ください',
          'detail', jsonb_build_object('lead_minutes', s.rp_same_day_lead_minutes));
      end if;
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 当日の貸切は受けない (カートの準備が要る / 2026-08 オーナー確認)
    if p_date < aone_today() + s.charter_min_lead_days then
      return jsonb_build_object('ok', false, 'reason', 'charter_lead_time',
        'message', case when s.charter_min_lead_days = 1
          then '貸切は前日までのお申し込みとなります。当日はお電話でご相談ください'
          else '貸切は ' || s.charter_min_lead_days || ' 日前までのお申し込みとなります' end,
        'detail', jsonb_build_object('lead_days', s.charter_min_lead_days));
    end if;

    -- コース貸切のみ (レンタルカート無し) は都度見積り。必ず折り返す
    if p_charter = 'course_only' then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'course_only',
        'message', 'コースのみの貸切は内容により料金が変わります。A-ONE より折り返しご連絡いたします');
    end if;

    -- 最小台数を下回る申込は受けない (レンタルカート付きのみ)
    if coalesce(p_vehicles, s.charter_min_karts) < s.charter_min_karts then
      return jsonb_build_object('ok', false, 'reason', 'charter_min_karts',
        'message', '貸切はカート ' || s.charter_min_karts || ' 台以上から承ります',
        'detail', jsonb_build_object('karts', p_vehicles, 'min', s.charter_min_karts));
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  to anon, authenticated, service_role;

create or replace function aone_create_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s           aone_settings%rowtype;
  v_kind      text := payload->>'kind';
  v_date      date := (payload->>'date')::date;
  v_session   text := nullif(payload->>'session', '');
  v_cat       text := nullif(payload->>'category_code', '');
  v_start     time := nullif(payload->>'start_time', '')::time;
  v_end       time := nullif(payload->>'end_time', '')::time;
  v_party     integer := coalesce(nullif(payload->>'party_size', '')::int, 1);
  v_forced    boolean := coalesce((payload->>'forced')::boolean, false);
  v_check     jsonb;
  v_status    text;
  v_customer  uuid;
  v_row       aone_reservations%rowtype;
begin
  select * into s from aone_settings where id = 1;

  if v_kind is null or v_date is null then
    raise exception '予約種別と日付は必須です' using errcode = 'AONE1', hint = 'bad_request';
  end if;
  if coalesce(trim(payload->'contact'->>'name'), '') = '' then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;

  -- 同日の予約を直列化する
  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  -- RP / 貸切の終了時刻を補完
  if v_kind = 'rp' and v_end is null and v_start is not null then
    v_end := (v_start + make_interval(mins => s.rp_duration_minutes))::time;
  end if;
  if v_kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_session) w;
  end if;

  v_check := aone_check_availability(
    v_kind, v_date, v_cat, v_session,
    case when v_kind = 'sport' then null else nullif(payload->>'start_time', '')::time end,
    case when v_kind = 'sport' then null else v_end end,
    v_party, null,
    nullif(payload->>'vehicle_count', '')::int,
    nullif(payload->>'charter_type', ''));

  if not (v_check->>'ok')::boolean then
    if not v_forced then
      raise exception '%', v_check->>'message'
        using errcode = 'AONE1', hint = v_check->>'reason';
    end if;
    v_status := 'confirmed';   -- 強制受付は確定扱い
  else
    v_status := coalesce(v_check->>'status', 'confirmed');
  end if;

  -- 管理者が明示的に状態を指定した場合はそれを優先
  if nullif(payload->>'status', '') is not null then
    v_status := payload->>'status';
  end if;

  v_customer := aone_upsert_customer(
    payload->'contact'->>'name',
    payload->'contact'->>'kana',
    payload->'contact'->>'phone',
    payload->'contact'->>'email');

  insert into aone_reservations (
    kind, status, date, session, start_time, end_time, category_code, night_kind,
    charter_type, party_size, vehicle_count, customer_id,
    contact_name, contact_kana, contact_phone, contact_email, preferred_contact,
    source, request_note, staff_memo, amount, forced, forced_reason,
    terms_agreed_at, created_by
  ) values (
    v_kind, v_status, v_date, v_session, v_start, v_end, v_cat,
    nullif(payload->>'night_kind', ''),
    nullif(payload->>'charter_type', ''),
    v_party,
    nullif(payload->>'vehicle_count', '')::int,
    v_customer,
    trim(payload->'contact'->>'name'),
    nullif(trim(payload->'contact'->>'kana'), ''),
    nullif(trim(payload->'contact'->>'phone'), ''),
    nullif(lower(trim(payload->'contact'->>'email')), ''),
    nullif(payload->>'preferred_contact', ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'request_note', ''),
    nullif(payload->>'staff_memo', ''),
    nullif(payload->>'amount', '')::int,
    v_forced,
    nullif(payload->>'forced_reason', ''),
    case when coalesce((payload->>'terms_agreed')::boolean, false) then now() else null end,
    nullif(payload->>'created_by', '')
  ) returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, case when v_forced and not (v_check->>'ok')::boolean then 'forced' else 'created' end,
          coalesce(nullif(payload->>'created_by', ''), 'customer'),
          jsonb_build_object('check', v_check, 'source', v_row.source));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'access_token', v_row.access_token,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'category_code', v_row.category_code,
    'night_kind', v_row.night_kind,
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

create or replace function aone_update_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  s        aone_settings%rowtype;
  v_row    aone_reservations%rowtype;
  v_before jsonb;
  v_date   date;
  v_start  time;
  v_end    time;
  v_sess   text;
  v_cat    text;
  v_party  integer;
  v_forced boolean := coalesce((payload->>'forced')::boolean, false);
  v_check  jsonb;
  v_status text;
begin
  select * into s from aone_settings where id = 1;

  if nullif(payload->>'access_token', '') is not null then
    select * into v_row from aone_reservations where access_token = (payload->>'access_token')::uuid;
  else
    select * into v_row from aone_reservations where id = (payload->>'id')::uuid;
  end if;

  if v_row.id is null then
    raise exception '予約が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;
  if v_row.status in ('cancelled', 'no_show') then
    raise exception 'この予約は既にキャンセルされています' using errcode = 'AONE1', hint = 'already_cancelled';
  end if;

  v_before := to_jsonb(v_row);

  v_date  := coalesce(nullif(payload->>'date', '')::date, v_row.date);
  v_sess  := coalesce(nullif(payload->>'session', ''), v_row.session);
  v_cat   := coalesce(nullif(payload->>'category_code', ''), v_row.category_code);
  v_party := coalesce(nullif(payload->>'party_size', '')::int, v_row.party_size);
  v_start := coalesce(nullif(payload->>'start_time', '')::time, v_row.start_time);
  v_end   := nullif(payload->>'end_time', '')::time;

  perform pg_advisory_xact_lock(hashtext('aone:' || v_date::text));

  if v_row.kind = 'sport' then
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;
  elsif v_row.kind = 'rp' then
    v_end := coalesce(v_end, (v_start + make_interval(mins => s.rp_duration_minutes))::time);
  else
    v_end := coalesce(v_end, v_row.end_time);
  end if;

  -- 自分自身を除外して再判定 (仕様 4: 変更時に最新の空き状況を再判定)
  v_check := aone_check_availability(
    v_row.kind, v_date, v_cat, v_sess,
    case when v_row.kind = 'sport' then null else v_start end,
    case when v_row.kind = 'sport' then null else v_end end,
    v_party, v_row.id,
    coalesce(nullif(payload->>'vehicle_count', '')::int, v_row.vehicle_count),
    coalesce(nullif(payload->>'charter_type', ''), v_row.charter_type));

  if not (v_check->>'ok')::boolean and not v_forced then
    raise exception '%', v_check->>'message'
      using errcode = 'AONE1', hint = v_check->>'reason';
  end if;

  -- 確定済みの予約は、変更後も確定のまま維持する (要相談枠に落ちた場合を除く)
  v_status := case
    when v_row.status in ('confirmed', 'completed') and (v_check->>'status') = 'checking'
      then 'checking'
    else v_row.status
  end;

  update aone_reservations set
    date          = v_date,
    session       = v_sess,
    category_code = v_cat,
    start_time    = v_start,
    end_time      = v_end,
    party_size    = v_party,
    vehicle_count = coalesce(nullif(payload->>'vehicle_count', '')::int, vehicle_count),
    status        = v_status,
    contact_name  = coalesce(nullif(trim(payload->'contact'->>'name'), ''), contact_name),
    contact_kana  = coalesce(nullif(trim(payload->'contact'->>'kana'), ''), contact_kana),
    contact_phone = coalesce(nullif(trim(payload->'contact'->>'phone'), ''), contact_phone),
    contact_email = coalesce(nullif(lower(trim(payload->'contact'->>'email')), ''), contact_email),
    request_note  = coalesce(nullif(payload->>'request_note', ''), request_note),
    staff_memo    = coalesce(nullif(payload->>'staff_memo', ''), staff_memo),
    amount        = coalesce(nullif(payload->>'amount', '')::int, amount),
    forced        = forced or (v_forced and not (v_check->>'ok')::boolean)
  where id = v_row.id
  returning * into v_row;

  insert into aone_reservation_events (reservation_id, event, actor, detail)
  values (v_row.id, 'updated', coalesce(nullif(payload->>'actor', ''), 'customer'),
          jsonb_build_object('before', v_before - 'access_token', 'check', v_check));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'session', v_row.session,
    'start_time', to_char(v_row.start_time, 'HH24:MI'),
    'end_time', to_char(v_row.end_time, 'HH24:MI'),
    'party_size', v_row.party_size,
    'check', v_check
  );
end;
$$;

revoke all on function aone_create_reservation(jsonb) from public, anon, authenticated;
revoke all on function aone_update_reservation(jsonb) from public, anon, authenticated;
grant execute on function aone_create_reservation(jsonb) to service_role;
grant execute on function aone_update_reservation(jsonb) to service_role;

-- ###########################################################################
-- # 0021_business_and_surface_status.sql
-- ###########################################################################

-- =============================================================================
-- 営業状況と路面状況を分ける
-- =============================================================================
-- 2026-08 オーナー指示:
--
--   営業状況 … 基本は「営業中」。休みの日は「休業」。臨時休業は管理画面で設定。
--   路面状況 … 営業状況とは別軸。ドライ / ウェット / ウェット→ドライ / ヘビーウェット
--
-- これまでは weather_status 1 本に「通常営業・雨天注意・営業確認中・
-- 路面回復待ち・雨天中止」が混ざっていた。「営業しているが路面はウェット」と
-- 「休業」を同じ列で表せないので、お客様に伝えたいことが伝わらなかった。
--
--   business_status … 営業しているか (受付可否に影響する)
--   surface_status  … 走ってみた路面の状態 (受付可否には一切影響しない)
--
-- 旧値からの読み替え:
--   normal           → open     / 路面なし
--   rain_caution     → open     / wet
--   checking         → checking / 路面なし
--   surface_recovery → open     / drying
--   cancelled        → cancelled/ 路面なし
--   other            → open     / 路面なし
--
-- ★ この設定を変えてもお客様には自動でメールを送らない。
--   急な休みは電話で連絡する運用のため (お知らせは一括連絡・個別連絡から手動で送る)。
-- =============================================================================

alter table aone_business_days
  add column if not exists business_status text not null default 'open'
    check (business_status in (
      'open',      -- 営業中 (既定)
      'checking',  -- 営業確認中 (走れるか判断中)
      'cancelled', -- 走行中止 (営業日だが天候等で走れない)
      'closed'     -- 休業
    )),
  add column if not exists surface_status text
    check (surface_status in (
      'dry',       -- ドライ
      'wet',       -- ウェット
      'drying',    -- ウェット→ドライ
      'heavy_wet'  -- ヘビーウェット
    ));

comment on column aone_business_days.business_status is
  '営業状況。受付可否に影響する (closed / cancelled は予約を止める)';
comment on column aone_business_days.surface_status is
  '路面状況。表示のみで受付可否には影響しない。null = 未設定 (表示しない)';

-- 旧 weather_status からの読み替え (既に business_status を触っている行は上書きしない)
update aone_business_days set
  business_status = case weather_status
    when 'checking'  then 'checking'
    when 'cancelled' then 'cancelled'
    else 'open' end,
  surface_status = case weather_status
    when 'rain_caution'     then 'wet'
    when 'surface_recovery' then 'drying'
    else null end
where business_status = 'open' and surface_status is null
  and weather_status is not null and weather_status <> 'normal';

-- weather_status は読まなくなった。列は履歴として残すが、既定値と NOT NULL を外して
-- 「ここを書いても何も起きない」ことをはっきりさせる。
alter table aone_business_days alter column weather_status drop default;
alter table aone_business_days alter column weather_status drop not null;
comment on column aone_business_days.weather_status is
  '廃止列。どこからも読んでいない。営業状況は business_status、路面は surface_status を使う';

-- -----------------------------------------------------------------------------
-- 受付判定: 休業・走行中止は予約を止める (路面状況は止めない)
-- -----------------------------------------------------------------------------
create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null,  -- 貸切のカート台数
  p_charter  text default null      -- 貸切の種別 (with_karts / course_only)
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 営業状況 (仕様 8) — 休業・走行中止は受け付けない。
  -- 路面状況 (surface_status) は表示だけで、ここでは一切見ない。
  select business_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', 'この日は走行中止となっています');
  elsif v_weather = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'business_closed',
      'message', 'この日は休業日です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 当日の RP は準備とスタッフの都合で制限がきびしい (2026-08 オーナー確認)
    if p_date = aone_today() then
      if p_start >= s.rp_same_day_last_start then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_late',
          'message', '本日のレースパックは ' || to_char(s.rp_same_day_last_start, 'HH24:MI')
            || ' より前の開始のみ承ります。お電話でご相談ください');
      end if;
      if ((p_date + p_start) at time zone 'Asia/Tokyo')
           < now() + make_interval(mins => s.rp_same_day_lead_minutes) then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_too_soon',
          'message', '本日のレースパックは ' || (s.rp_same_day_lead_minutes / 60)
            || ' 時間後以降のお時間でご予約ください。お急ぎの場合はお電話ください',
          'detail', jsonb_build_object('lead_minutes', s.rp_same_day_lead_minutes));
      end if;
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 当日の貸切は受けない (カートの準備が要る / 2026-08 オーナー確認)
    if p_date < aone_today() + s.charter_min_lead_days then
      return jsonb_build_object('ok', false, 'reason', 'charter_lead_time',
        'message', case when s.charter_min_lead_days = 1
          then '貸切は前日までのお申し込みとなります。当日はお電話でご相談ください'
          else '貸切は ' || s.charter_min_lead_days || ' 日前までのお申し込みとなります' end,
        'detail', jsonb_build_object('lead_days', s.charter_min_lead_days));
    end if;

    -- コース貸切のみ (レンタルカート無し) は都度見積り。必ず折り返す
    if p_charter = 'course_only' then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'course_only',
        'message', 'コースのみの貸切は内容により料金が変わります。A-ONE より折り返しご連絡いたします');
    end if;

    -- 最小台数を下回る申込は受けない (レンタルカート付きのみ)
    if coalesce(p_vehicles, s.charter_min_karts) < s.charter_min_karts then
      return jsonb_build_object('ok', false, 'reason', 'charter_min_karts',
        'message', '貸切はカート ' || s.charter_min_karts || ' 台以上から承ります',
        'detail', jsonb_build_object('karts', p_vehicles, 'min', s.charter_min_karts));
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 日別ダイジェスト: business (営業状況) と surface (路面状況) を別々に返す
-- -----------------------------------------------------------------------------
create or replace function aone_day_state(p_date date) returns jsonb
language plpgsql stable as $$
declare
  s          aone_settings%rowtype;
  v_holiday  boolean;
  v_weather  record;
  v_blocks   jsonb;
  v_sport    jsonb := '{}'::jsonb;
  v_sess     text;
  v_cats     jsonb;
  v_cat      record;
  v_check    jsonb;
  v_status   text;
  v_start    time;
  v_end      time;
  v_classes  integer;
  v_limit    integer;
  v_peak     integer;
  v_has_cat  boolean;
  v_open_cnt integer;
  v_rp_slots jsonb := '[]'::jsonb;
  v_t        time;
  v_groups   integer;
  v_rp_chk   jsonb;
  v_charter  jsonb;
  v_counts   jsonb;
  v_biz      text;
  v_biz_src  text;
  v_surface  text;
begin
  select * into s from aone_settings where id = 1;
  v_holiday := aone_is_holiday(p_date);

  select bd.business_status, bd.surface_status, bd.status_message, bd.staff_note
    into v_weather
  from aone_business_days bd where bd.date = p_date;

  v_biz     := coalesce(v_weather.business_status, 'open');
  v_biz_src := 'manual';
  v_surface := v_weather.surface_status;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'title', b.title, 'kind', b.kind, 'scope', b.scope,
           'category_code', b.category_code,
           'start_time', to_char(b.start_time, 'HH24:MI'),
           'end_time', to_char(b.end_time, 'HH24:MI'),
           'is_public', b.is_public,
           'public_label', coalesce(b.public_label, b.title),
           'memo', b.memo
         ) order by b.start_time nulls first, b.title), '[]'::jsonb)
    into v_blocks
  from aone_blocks b where b.date = p_date;

  -- 臨時休業を予定として登録してあれば、営業状況は自動で「休業」になる。
  -- 予定と当日の表示を二重に入力させない (入力が 2 か所あると必ず片方が腐る)。
  if v_biz = 'open' and exists (
    select 1 from aone_blocks b
    where b.date = p_date and b.kind = 'closed' and b.scope = 'all'
  ) then
    v_biz     := 'closed';
    v_biz_src := 'block';
  end if;

  -- ---- スポーツ走行 (午前 / 午後) ----------------------------------------
  foreach v_sess in array array['am','pm'] loop
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(v_sess) w;

    v_limit := case
      when v_holiday and v_sess = 'am' then s.max_classes_holiday_am
      when v_holiday and v_sess = 'pm' then s.max_classes_holiday_pm
      when v_sess = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    select count(distinct r.category_code) into v_classes
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, null);

    v_cats := '[]'::jsonb;
    v_open_cnt := 0;
    for v_cat in select * from aone_categories where is_active order by sort_order loop
      v_check := aone_check_availability('sport', p_date, v_cat.code, v_sess, null, null, 1, null);

      select bool_or(r.category_code = v_cat.code) into v_has_cat
      from aone_reservations r
      where r.date = p_date and r.kind = 'sport' and r.session = v_sess and aone_is_live(r.status);

      if (v_check->>'ok')::boolean then
        -- スポーツ走行に「残りわずか (△)」は出さない (2026-08 オーナー指示)。
        -- 利用者が知りたいのは「走れるか / 走れないか」だけで、△ は迷わせるだけ。
        -- 残りクラス数はスタッフが used_classes / max_classes で把握できる。
        v_status := 'open';
        v_open_cnt := v_open_cnt + 1;
      elsif v_check->>'reason' in ('weather_cancelled', 'business_closed', 'blocked', 'past_date') then
        v_status := 'off';
      else
        v_status := 'closed';
      end if;

      v_cats := v_cats || jsonb_build_object(
        'code', v_cat.code,
        'name', v_cat.name,
        'short_name', coalesce(v_cat.short_name, v_cat.name),
        'status', v_status,
        'running', coalesce(v_has_cat, false),
        -- 予約が必要なカテゴリーか (false = 飛び込みでも走れる)
        'requires_reservation', v_cat.requires_reservation,
        -- true = 予約フォームに出さない (管理画面からの代理入力のみ受け付ける)
        'admin_only', v_cat.admin_only,
        -- 予約なしで今そのまま走れるか
        'walk_in_ok', v_status in ('open','limited')
                      and (not v_cat.requires_reservation or coalesce(v_has_cat, false)),
        'reason', v_check->>'reason',
        'message', v_check->>'message'
      );
    end loop;

    v_sport := v_sport || jsonb_build_object(v_sess, jsonb_build_object(
      'start_time', to_char(v_start, 'HH24:MI'),
      'end_time',   to_char(v_end, 'HH24:MI'),
      'max_classes', v_limit,
      'used_classes', coalesce(v_classes, 0),
      'rp_groups', v_peak,
      'accepting', v_open_cnt > 0,
      'categories', v_cats
    ));
  end loop;

  -- ---- RP 30 分刻みの空き ------------------------------------------------
  v_t := s.rp_first_start_time;
  while v_t <= s.rp_late_limit_time loop
    select count(*) into v_groups
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = v_t and aone_is_live(r.status);

    v_rp_chk := aone_check_availability('rp', p_date, null, null, v_t, null, s.rp_min_party, null);

    v_rp_slots := v_rp_slots || jsonb_build_object(
      'time', to_char(v_t, 'HH24:MI'),
      'groups', v_groups,
      'max_groups', s.rp_max_groups_per_start,
      'accepting', (v_rp_chk->>'ok')::boolean,
      'status', v_rp_chk->>'status',
      'reason', v_rp_chk->>'reason',
      'message', v_rp_chk->>'message'
    );
    v_t := (v_t + make_interval(mins => s.rp_slot_minutes))::time;
  end loop;

  -- ---- 貸切 --------------------------------------------------------------
  select jsonb_build_object(
    'reservations_today', (
      select count(*) from aone_reservations r
      where r.date = p_date and aone_is_live(r.status)),
    'confirmed_charter', exists (
      select 1 from aone_reservations r
      where r.date = p_date and r.kind = 'charter' and r.status = 'confirmed'),
    'accepting', not exists (
      select 1 from aone_blocking_blocks(p_date, 'charter', null,
                                         s.charter_first_start_time, s.charter_last_end_time))
  ) into v_charter;

  -- ---- 当日の予約件数 ----------------------------------------------------
  select jsonb_build_object(
    'sport',   count(*) filter (where kind = 'sport'   and aone_is_live(status)),
    'rp',      count(*) filter (where kind = 'rp'      and aone_is_live(status)),
    'charter', count(*) filter (where kind = 'charter' and aone_is_live(status)),
    'night',   count(*) filter (where kind = 'night'   and aone_is_live(status)),
    'people',  coalesce(sum(party_size) filter (where aone_is_live(status)), 0)
  ) into v_counts
  from aone_reservations where date = p_date;

  return jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'dow', extract(dow from p_date)::int,
    'is_holiday', v_holiday,
    'is_past', p_date < aone_today(),
    'is_today', p_date = aone_today(),
    'business', jsonb_build_object(
      'status',     v_biz,
      'source',     v_biz_src,
      'message',    v_weather.status_message,
      'staff_note', v_weather.staff_note
    ),
    'surface', jsonb_build_object('status', v_surface),
    'hours', jsonb_build_object(
      'course_open',  to_char(s.course_open_time, 'HH24:MI'),
      'course_close', to_char(s.course_close_time, 'HH24:MI')
    ),
    'blocks', v_blocks,
    'sport', v_sport,
    'rp', jsonb_build_object(
      'min_party', s.rp_min_party,
      'last_start', to_char(s.rp_last_start_time, 'HH24:MI'),
      'duration_minutes', s.rp_duration_minutes,
      'slots', v_rp_slots
    ),
    'charter', v_charter,
    'counts', v_counts
  );
end;
$$;



alter function aone_day_state(date) security definer set search_path = public, pg_temp;
grant execute on function aone_day_state(date) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 月ダイジェストも同じ 2 軸で返す
-- -----------------------------------------------------------------------------
create or replace function aone_month_state(p_year integer, p_month integer) returns jsonb
language sql stable as $$
  with days as (
    select generate_series(
      make_date(p_year, p_month, 1),
      (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date,
      interval '1 day')::date as d
  ),
  -- MATERIALIZED が必須: 付けないと下で st を参照するたびに
  -- aone_day_state() が再評価され、1 か月ぶんで数秒かかる。
  states as materialized (
    select d, aone_day_state(d) as st from days
  )
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'date', to_char(d, 'YYYY-MM-DD'),
      'dow', extract(dow from d)::int,
      'is_holiday', st->>'is_holiday' = 'true',
      'business', st->'business'->>'status',
      'surface', st->'surface'->>'status',
      'sport_am', st->'sport'->'am'->>'accepting',
      'sport_pm', st->'sport'->'pm'->>'accepting',
      -- カテゴリーごとの状態 (何が走れるかを出すため)
      'am_categories', st->'sport'->'am'->'categories',
      'pm_categories', st->'sport'->'pm'->'categories',
      'rp_free', (select count(*) from jsonb_array_elements(st->'rp'->'slots') s
                   where (s->>'accepting')::boolean),
      'blocks', (select coalesce(jsonb_agg(jsonb_build_object(
                          'title', b->>'title',
                          'public_label', b->>'public_label',
                          'kind', b->>'kind',
                          'is_public', (b->>'is_public')::boolean)), '[]'::jsonb)
                 from jsonb_array_elements(st->'blocks') b),
      'counts', st->'counts'
    ) as x
    from states
  ) y;
$$;

alter function aone_month_state(integer, integer) security definer set search_path = public, pg_temp;
grant execute on function aone_month_state(integer, integer) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0022_event_entries.sql
-- ###########################################################################

-- =============================================================================
-- イベントの参加申込 (エントリー)
-- =============================================================================
-- 2026-08 オーナー指示: レース・イベントの参加申込も予約システムで受ける。
--
-- 走行の予約とは別物なので台帳を分ける。理由:
--   * 聞く項目がまったく違う (チーム名・ゼッケン・参加クラス・フレームメーカー)
--   * 走行枠を消費しない。イベント日はブロック予定が終日止めているので、
--     エントリーが増えても受付可否は変わらない
--   * 「1 チーム 20,000 円」と「1 人 7,000 円」が混ざり、人数 × 単価では出せない
--
-- ただし顧客は共通 (aone_upsert_customer) にして、電話番号・メールで名寄せする。
-- 「レースに出た人が普段も走りに来る」がふつうなので、顧客台帳が割れると困る。
--
-- 申込の様式は 3 つ:
--   endurance … レンタルカート耐久。チーム単位。代表者 1 名を聞く
--   sprint    … レンタルカートスプリント。人単位。チーム名も聞く
--   series    … RMC シリーズ戦。人単位。フレームメーカー・希望ゼッケン・参加クラス
--
-- 参加費はイベントごとに管理画面で入れる (2026-08 オーナー確認)。
-- クラスや年で変わるため。null にすれば「お問い合わせ」表示になる。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 予定 (aone_blocks) にエントリー受付の設定を持たせる
-- -----------------------------------------------------------------------------
-- 開催日はカレンダーに登録した予定そのもの。日付を二度入力させない。
alter table aone_blocks
  add column if not exists entry_open boolean not null default false,
  add column if not exists entry_type text
    check (entry_type in ('endurance', 'sprint', 'series')),
  add column if not exists entry_price integer check (entry_price >= 0),
  add column if not exists entry_unit text not null default 'person'
    check (entry_unit in ('team', 'person')),
  add column if not exists entry_deadline date,
  add column if not exists entry_rules_url text,
  add column if not exists entry_vehicle_rules_url text,
  add column if not exists entry_classes text[] not null default '{}',
  add column if not exists entry_note text;

comment on column aone_blocks.entry_open is
  'true = この予定の参加申込を受け付ける。false なら申込フォームに出ない';
comment on column aone_blocks.entry_price is
  '参加費。null = 金額を出さずに受け付け、A-ONE から折り返し連絡する';
comment on column aone_blocks.entry_deadline is
  '申込締切 (この日まで受付)。null なら開催日の前日まで';
comment on column aone_blocks.entry_classes is
  'series のときの参加クラスの選択肢。空なら参加クラスを聞かない';

-- -----------------------------------------------------------------------------
-- 2. エントリー台帳
-- -----------------------------------------------------------------------------
create sequence if not exists aone_entry_seq;

create or replace function aone_next_entry_number() returns text
language sql volatile as $$
  select 'E' || to_char((now() at time zone 'Asia/Tokyo')::date, 'YYMMDD')
       || '-' || lpad((nextval('aone_entry_seq') % 10000)::text, 4, '0');
$$;

create table if not exists aone_event_entries (
  id uuid primary key default gen_random_uuid(),
  entry_number text unique not null default aone_next_entry_number(),

  -- 予定を消しても申込の記録は残す (誰から何を受けたかは経理・連絡に要る)
  block_id uuid references aone_blocks(id) on delete set null,
  date date not null,                 -- 開催日 (block から写す)
  event_title text not null,          -- 申込時点のイベント名 (あとで改名されても記録は変わらない)
  entry_type text not null check (entry_type in ('endurance', 'sprint', 'series')),

  status text not null default 'received'
    check (status in (
      'received',   -- 受付済み (A-ONE 側の確認待ち)
      'confirmed',  -- 参加確定
      'cancelled'   -- 取り消し
    )),

  customer_id uuid references aone_customers(id) on delete set null,

  team_name     text,                 -- チーム名
  contact_name  text not null,        -- 代表者 / 参加者の氏名
  contact_kana  text,
  contact_email text not null,
  contact_phone text not null,

  -- シリーズ戦だけの項目
  frame_maker text,
  number_wish text,                   -- 希望ゼッケン
  race_class  text,

  amount   integer check (amount >= 0),
  is_paid  boolean not null default false,
  agreed_at timestamptz,              -- 特別規則書・車輌規則に同意した時刻

  note       text,                    -- お客様からの連絡事項
  staff_memo text,                    -- 顧客には出さない

  -- 予約と同じく、専用 URL を知っていること = 本人 (仕様 10)
  access_token uuid not null default gen_random_uuid(),

  source text not null default 'web' check (source in ('web', 'phone', 'counter', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  cancelled_at timestamptz,
  cancel_reason text
);

create index if not exists aone_entries_date_idx  on aone_event_entries (date);
create index if not exists aone_entries_block_idx on aone_event_entries (block_id);
create index if not exists aone_entries_cust_idx  on aone_event_entries (customer_id);
create unique index if not exists aone_entries_token_idx on aone_event_entries (access_token);

drop trigger if exists aone_entry_touch on aone_event_entries;
create trigger aone_entry_touch before update on aone_event_entries
  for each row execute function aone_touch_updated_at();

-- -----------------------------------------------------------------------------
-- 3. 受付中のイベント (公開用)
-- -----------------------------------------------------------------------------
-- 締切を過ぎたもの・過去のものは出さない。申込フォームの一覧に使う。
create or replace function aone_open_events() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id,
      'date', to_char(b.date, 'YYYY-MM-DD'),
      'title', coalesce(nullif(b.public_label, ''), b.title),
      'kind', b.kind,
      'entry_type', b.entry_type,
      'price', b.entry_price,
      'unit', b.entry_unit,
      'deadline', to_char(coalesce(b.entry_deadline, b.date - 1), 'YYYY-MM-DD'),
      'rules_url', nullif(b.entry_rules_url, ''),
      'vehicle_rules_url', nullif(b.entry_vehicle_rules_url, ''),
      'classes', to_jsonb(b.entry_classes),
      'note', nullif(b.entry_note, ''),
      'entries', (select count(*) from aone_event_entries e
                   where e.block_id = b.id and e.status <> 'cancelled')
    ) as x
    from aone_blocks b
    where b.entry_open
      and b.entry_type is not null
      and coalesce(b.entry_deadline, b.date - 1) >= aone_today()
  ) y;
$$;

alter function aone_open_events() security definer set search_path = public, pg_temp;
grant execute on function aone_open_events() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. 申込の作成
-- -----------------------------------------------------------------------------
-- 受付可否の判定は「イベントが受付中か」「締切前か」だけ。走行枠は見ない
-- (イベント日は予定が終日止めているので、エントリー数は空きに影響しない)。
create or replace function aone_create_event_entry(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  b          aone_blocks%rowtype;
  v_row      aone_event_entries%rowtype;
  v_customer uuid;
  v_forced   boolean := coalesce((payload->>'forced')::boolean, false);
  v_type     text;
  v_amount   integer;
  v_name     text := nullif(trim(payload->'contact'->>'name'), '');
  v_email    text := nullif(trim(payload->'contact'->>'email'), '');
  v_phone    text := nullif(trim(payload->'contact'->>'phone'), '');
  v_team     text := nullif(trim(payload->>'team_name'), '');
  v_class    text := nullif(trim(payload->>'race_class'), '');
begin
  select * into b from aone_blocks where id = (payload->>'block_id')::uuid;
  if not found then
    raise exception 'イベントが見つかりません' using errcode = 'AONE1', hint = 'event_not_found';
  end if;
  if b.entry_type is null then
    raise exception 'このイベントは参加申込を受け付けていません'
      using errcode = 'AONE1', hint = 'entry_closed';
  end if;
  v_type := b.entry_type;

  -- 管理者の代理入力は締切後でも通す (電話で受けた分をあとから入れるため)
  if not v_forced then
    if not b.entry_open then
      raise exception 'このイベントは参加申込を受け付けていません'
        using errcode = 'AONE1', hint = 'entry_closed';
    end if;
    if coalesce(b.entry_deadline, b.date - 1) < aone_today() then
      raise exception using errcode = 'AONE1', hint = 'entry_deadline',
        message = '申込の受付は '
          || to_char(coalesce(b.entry_deadline, b.date - 1), 'YYYY年MM月DD日')
          || ' で終了しました';
    end if;
  end if;

  -- 必須項目。フォーム側でも見ているが、API を直に叩かれても崩れないようにする
  if v_name is null then
    raise exception 'お名前を入力してください' using errcode = 'AONE1', hint = 'missing_name';
  end if;
  if v_email is null or position('@' in v_email) = 0 then
    raise exception 'メールアドレスを入力してください' using errcode = 'AONE1', hint = 'missing_email';
  end if;
  if v_phone is null then
    raise exception 'お電話番号を入力してください' using errcode = 'AONE1', hint = 'missing_phone';
  end if;
  if v_team is null then
    raise exception 'チーム名を入力してください' using errcode = 'AONE1', hint = 'missing_team';
  end if;
  -- 参加クラスは選択肢が登録されているときだけ必須
  if v_type = 'series' and array_length(b.entry_classes, 1) is not null and v_class is null then
    raise exception '参加クラスを選んでください' using errcode = 'AONE1', hint = 'missing_class';
  end if;

  -- 金額。チーム単位ならそのまま、人単位でも申込 1 件 = 1 名なのでそのまま
  -- (複数名をまとめて申し込む導線は作らない。1 人 1 件で受ける)
  v_amount := b.entry_price;

  v_customer := aone_upsert_customer(
    v_name, payload->'contact'->>'kana', v_phone, v_email);

  insert into aone_event_entries (
    block_id, date, event_title, entry_type, status, customer_id,
    team_name, contact_name, contact_kana, contact_email, contact_phone,
    frame_maker, number_wish, race_class,
    amount, agreed_at, note, staff_memo, source, created_by
  ) values (
    b.id, b.date, coalesce(nullif(b.public_label, ''), b.title), v_type,
    coalesce(nullif(payload->>'status', ''), 'received'),
    v_customer,
    v_team, v_name, nullif(trim(payload->'contact'->>'kana'), ''), lower(v_email), v_phone,
    nullif(trim(payload->>'frame_maker'), ''),
    nullif(trim(payload->>'number_wish'), ''),
    v_class,
    v_amount,
    case when coalesce((payload->>'agreed')::boolean, false) then now() else null end,
    nullif(trim(payload->>'note'), ''),
    nullif(trim(payload->>'staff_memo'), ''),
    coalesce(nullif(payload->>'source', ''), 'web'),
    nullif(payload->>'actor', '')
  ) returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'entry_number', v_row.entry_number,
    'access_token', v_row.access_token,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'event_title', v_row.event_title,
    'entry_type', v_row.entry_type,
    'amount', v_row.amount,
    'status', v_row.status
  );
end;
$$;

alter function aone_create_event_entry(jsonb) security definer set search_path = public, pg_temp;
grant execute on function aone_create_event_entry(jsonb) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. 申込の取り消し
-- -----------------------------------------------------------------------------
create or replace function aone_cancel_event_entry(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row aone_event_entries%rowtype;
begin
  select * into v_row from aone_event_entries
  where (payload->>'id' is not null and id = (payload->>'id')::uuid)
     or (payload->>'access_token' is not null and access_token = (payload->>'access_token')::uuid);
  if not found then
    raise exception '申込が見つかりません' using errcode = 'AONE1', hint = 'not_found';
  end if;

  update aone_event_entries
     set status = 'cancelled',
         cancelled_at = now(),
         cancel_reason = nullif(trim(payload->>'reason'), '')
   where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status);
end;
$$;

alter function aone_cancel_event_entry(jsonb) security definer set search_path = public, pg_temp;
grant execute on function aone_cancel_event_entry(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 6. RLS — エントリーは個人情報なので anon には一切見せない
-- -----------------------------------------------------------------------------
alter table aone_event_entries enable row level security;
-- ポリシーを作らない = service_role 以外は読めない。
-- 公開側が知る必要があるのは「何件申し込まれているか」だけで、
-- それは aone_open_events() (SECURITY DEFINER) が集計して返す。

-- ⚠ 0005 の `grant all on all tables in schema public to service_role` は
--   その時点で存在したテーブルにしか効かない。あとから足したテーブルには
--   個別に grant が要る (これを忘れると管理画面が permission denied で落ちる)。
grant all on aone_event_entries to service_role;
grant usage, select on sequence aone_entry_seq to service_role;
grant execute on function aone_next_entry_number() to service_role;

-- ###########################################################################
-- # 0023_public_name_org.sql
-- ###########################################################################

-- =============================================================================
-- 公開表示の「姓のみ」が法人名・カタカナ姓で壊れていたのを直す
-- =============================================================================
-- 2026-08 実運用で発覚:
--
--   (株)ふーぷーパートナーズ → 「(株 様」
--   株)フーブパートナーズ     → 「株) 様」
--   エンドウ                  → 「エン 様」
--   ナカゾノ                  → 「ナカ 様」
--
-- 「空白が無ければ先頭 2 文字が姓」という決めうちが原因。日本人の姓名には
-- 効くが、法人名・団体名・カタカナだけの姓には効かない。
--
-- 貸切は「団体名が入るので略さない」と決めて逃げていたが、RP にも法人名や
-- チーム名で入る。種別ではなく **名前そのものを見て** 判断する。
--
-- 直したあとの規則 (family モード):
--   1. 法人・団体らしければ略さない    (株)ふーぷーパートナーズ / A-ONE Racing
--   2. 空白があれば先頭トークン        山田 太郎 → 山田
--   3. 漢字を含まなければ略さない      エンドウ / ナカゾノ (姓だけ入れた形)
--   4. 3 文字以下なら略さない          今井 / 佐々木
--   5. それ以外は先頭 2 文字           山田太郎 → 山田
--
-- full / hidden の挙動は変えていない。
-- =============================================================================

-- 法人・団体らしい名前か。ここに載っていない書き方は「個人名」として扱う
-- (略しすぎるより、略さないほうが実害が小さい)。
create or replace function aone_looks_like_org(p_name text) returns boolean
language sql immutable as $$
  select case
    when coalesce(trim(p_name), '') = '' then false
    -- (株) 【 ㈱ など記号で始まるものは、まず個人名ではない
    when trim(p_name) ~ '^[[:punct:]（）【】㈱㈲]' then true
    -- ラテン文字を含む (A-ONE Racing / SMG FUKUOKA)
    when p_name ~ '[A-Za-zＡ-Ｚａ-ｚ]' then true
    -- 法人格・組織を示す語
    when p_name ~ ('株式会社|有限会社|合同会社|㈱|㈲|株\)|株）|\(株|（株|有\)|\(有|'
                || '財団|社団|組合|大学|高校|中学|学園|学院|工科|工業|自動車|商事|'
                || 'レーシング|レース|チーム|クラブ|アカデミー|サービス|工房|商会') then true
    else false
  end;
$$;

comment on function aone_looks_like_org(text) is
  '法人・団体らしい名前か。公開表示で姓のみに略してよいかの判断に使う';

create or replace function aone_public_name(p_name text, p_mode text)
returns text
language sql immutable as $$
  with n as (select coalesce(aone_strip_honorific(p_name), trim(coalesce(p_name, ''))) as v)
  select case
    when p_mode = 'hidden' then null
    when (select v from n) = '' then null
    when p_mode = 'full' then (select v from n) || ' 様'

    -- 1. 法人・団体は略すと意味が通らなくなる。空白の判定より先に見る
    --    (「A-ONE Racing」を空白で切ると「A-ONE」になってしまう)
    when aone_looks_like_org((select v from n)) then (select v from n) || ' 様'

    -- 2. 空白があれば先頭を姓とみなす (山田 太郎 → 山田)
    when position(' ' in (select v from n)) > 0 or position('　' in (select v from n)) > 0
      then split_part(replace((select v from n), '　', ' '), ' ', 1) || ' 様'

    -- 3. 漢字を含まない = 姓だけを入れた形 (エンドウ / なかぞの) なのでそのまま
    when (select v from n) !~ '[一-龥々]' then (select v from n) || ' 様'

    -- 4. 短いものはそのまま (今井 / 佐々木)
    when length((select v from n)) <= 3 then (select v from n) || ' 様'

    -- 5. 漢字の姓名がつながっている (山田太郎) → 先頭 2 文字
    else left((select v from n), 2) || ' 様'
  end;
$$;

grant execute on function aone_looks_like_org(text) to anon, authenticated, service_role;

-- ###########################################################################
-- # 0024_only_category_block.sql
-- ###########################################################################

-- =============================================================================
-- 「このカテゴリーだけ走れる」予定
-- =============================================================================
-- 2026-08 オーナー要望 (レース前日の運用):
--
--   カートはそのまま走らせたい。ミニバイク等は弾きたい。
--
-- 今の停止範囲では表せなかった:
--   scope='sport'    … スポーツ走行を全部止める (カートも止まる)
--   scope='category' … 指定した 1 カテゴリーだけ止める
--                      → ミニバイク・キッズカート・その他 と 3 件登録が必要。
--                        カテゴリーが増えたら足し忘れる
--
-- そこで逆向きの指定を足す:
--   scope='only_category' … allow_categories に入れたカテゴリーだけ受け付け、
--                           ほかのスポーツ走行は止める
--
-- 「1 件登録すれば以後カテゴリーが増えても自動的に止まる」ほうが、
-- 走行枠の事故 (止めたいものが走れてしまう) を起こしにくい。
--
-- ★ すでに入っている予約は、あとから予定を足しても消えない。
--   ブロックが効くのは「これから受ける予約」だけ (aone_check_availability)。
--   だから「先に停止してから強制で入れ直す」必要はない。
-- =============================================================================

alter table aone_blocks
  add column if not exists allow_categories text[] not null default '{}';

comment on column aone_blocks.allow_categories is
  'scope=only_category のとき、走行を許すカテゴリー。ここに無いものは止める';

alter table aone_blocks drop constraint if exists aone_blocks_scope_check;
alter table aone_blocks add constraint aone_blocks_scope_check
  check (scope in ('all', 'am', 'pm', 'time', 'sport', 'rp', 'category', 'only_category'));

-- -----------------------------------------------------------------------------
-- 受付判定に only_category を足す
-- -----------------------------------------------------------------------------
create or replace function aone_blocking_blocks(
  p_date     date,
  p_kind     text,
  p_category text,
  p_start    time,
  p_end      time
)
returns table (id uuid, title text, kind text, scope text)
language sql stable as $$
  with s as (select * from aone_settings where id = 1),
  win as (
    select b.*,
      case b.scope
        when 'am'   then (select course_open_time from s)
        when 'pm'   then (select pm_start_time    from s)
        when 'time' then coalesce(b.start_time, time '00:00')
        else coalesce(b.start_time, time '00:00')
      end as w_start,
      case b.scope
        when 'am'   then (select am_end_time       from s)
        when 'pm'   then (select course_close_time from s)
        when 'time' then coalesce(b.end_time, time '23:59:59')
        else coalesce(b.end_time, time '23:59:59')
      end as w_end
    from aone_blocks b
    where b.date = p_date
  )
  select w.id, w.title, w.kind, w.scope
  from win w
  where
    -- 対象の予約種別に効くか
    case
      when w.scope = 'sport'    then p_kind = 'sport'
      when w.scope = 'rp'       then p_kind = 'rp'
      when w.scope = 'category' then p_kind = 'sport'
                                  and (w.category_code is null or w.category_code = p_category)
      -- 許可したカテゴリー以外のスポーツ走行を止める。
      -- 許可が空のときは何も止めない (登録し忘れで全部止まると事故になる)
      when w.scope = 'only_category' then p_kind = 'sport'
                                  and array_length(w.allow_categories, 1) is not null
                                  and not (p_category = any (w.allow_categories))
      else
        case p_kind
          when 'sport'   then w.blocks_sport
          when 'night'   then w.blocks_sport
          when 'rp'      then w.blocks_rp
          when 'charter' then w.blocks_charter
          else true
        end
    end
    -- 時間帯が重なるか (時刻未指定のブロックは終日扱い)
    and w.w_start < coalesce(p_end, time '23:59:59')
    and w.w_end   > coalesce(p_start, time '00:00');
$$;

alter function aone_blocking_blocks(date, text, text, time, time)
  security definer set search_path = public, pg_temp;
grant execute on function aone_blocking_blocks(date, text, text, time, time)
  to anon, authenticated, service_role;

-- ###########################################################################
-- # 0025_cron_log.sql
-- ###########################################################################

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

-- ###########################################################################
-- # 0026_weekly_sport_closed.sql
-- ###########################################################################

-- =============================================================================
-- 毎週の定休 (曜日 × 午前/午後 でスポーツ走行を止める)
-- =============================================================================
-- 2026-08 オーナー指示:
--
--   「日曜日の午後はスポーツ走行の予約は基本受けない」
--
-- 日付ではなく **曜日**で決まる決め事なので、ブロック予定 (aone_blocks) では
-- 表せない。毎週ぶんを登録する運用にすると、必ずいつか入れ忘れる。
--
--   * 止めるのは **スポーツ走行だけ**。RP・貸切・ナイターは通常どおり受ける
--     (日曜午後こそレンタルのお客様が来る時間帯)
--   * 「基本」なので、管理者は今までどおり `forced = true` で入れられる
--   * すでに入っている予約は消えない (§8.1 と同じ。効くのはこれから受ける予約だけ)
--   * 設定は /admin/settings の 曜日 × AM/PM のチェックで変えられる
-- =============================================================================

create table if not exists aone_weekly_sport_closed (
  -- 0 = 日曜 (postgres の extract(dow) に合わせる)
  dow     smallint not null check (dow between 0 and 6),
  session text     not null check (session in ('am', 'pm')),
  primary key (dow, session)
);

comment on table aone_weekly_sport_closed is
  '毎週この曜日・この時間帯はスポーツ走行を受け付けない、という決め事';

alter table aone_weekly_sport_closed enable row level security;

-- 公開ページも「日曜午後は ✕」と出すため、読むだけは誰でもできる
drop policy if exists aone_weekly_sport_closed_read on aone_weekly_sport_closed;
create policy aone_weekly_sport_closed_read on aone_weekly_sport_closed
  for select using (true);

-- ⚠ 0005 の `grant all on all tables in schema public to service_role` は
--   その時点で存在したテーブルにしか効かない (0022 で実際に踏んだ)
grant select on aone_weekly_sport_closed to anon, authenticated;
grant all on aone_weekly_sport_closed to service_role;

-- 日曜の午後を止める (オーナー指示の初期値)
insert into aone_weekly_sport_closed (dow, session) values (0, 'pm')
on conflict do nothing;

-- 曜日の日本語 (メッセージ用)
create or replace function aone_weekday_ja(p_date date) returns text
language sql immutable as $$
  select ('{日,月,火,水,木,金,土}'::text[])[extract(dow from p_date)::int + 1] || '曜日';
$$;

grant execute on function aone_weekday_ja(date) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 受付判定に毎週の定休を足す
-- -----------------------------------------------------------------------------
create or replace function aone_check_availability(
  p_kind     text,
  p_date     date,
  p_category text default null,
  p_session  text default null,
  p_start    time default null,
  p_end      time default null,
  p_party    integer default 1,
  p_exclude  uuid default null,
  p_vehicles integer default null,  -- 貸切のカート台数
  p_charter  text default null      -- 貸切の種別 (with_karts / course_only)
) returns jsonb
language plpgsql stable as $$
declare
  s            aone_settings%rowtype;
  v_start      time;
  v_end        time;
  v_weather    text;
  v_block      record;
  v_charter    record;
  v_classes    integer;
  v_has_cat    boolean;
  v_limit      integer;
  v_peak       integer;
  v_same_start integer;
  v_others     integer;
begin
  select * into s from aone_settings where id = 1;

  if p_date < aone_today() then
    return jsonb_build_object('ok', false, 'reason', 'past_date',
      'message', '過去の日付は予約できません');
  end if;

  -- 対象時間帯を決める
  if p_kind = 'sport' then
    if p_session is null or p_category is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', 'スポーツ走行は時間帯 (午前/午後) とカテゴリーが必要です');
    end if;
    select w.start_time, w.end_time into v_start, v_end from aone_session_window(p_session) w;
  else
    v_start := p_start;
    v_end   := coalesce(
      p_end,
      case when p_kind = 'rp'
        then (p_start + make_interval(mins => s.rp_duration_minutes))::time
        else (p_start + interval '1 hour')::time end);
  end if;

  -- 営業状況 (仕様 8) — 休業・走行中止は受け付けない。
  -- 路面状況 (surface_status) は表示だけで、ここでは一切見ない。
  select business_status into v_weather from aone_business_days where date = p_date;
  if v_weather = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'weather_cancelled',
      'message', 'この日は走行中止となっています');
  elsif v_weather = 'closed' then
    return jsonb_build_object('ok', false, 'reason', 'business_closed',
      'message', 'この日は休業日です');
  end if;

  -- ブロック予定 (仕様 14)
  select * into v_block from aone_blocking_blocks(p_date, p_kind, p_category, v_start, v_end) limit 1;
  if found then
    return jsonb_build_object('ok', false, 'reason', 'blocked',
      'message', v_block.title || ' のため、この時間帯は受付を停止しています',
      'detail', jsonb_build_object('block_id', v_block.id, 'title', v_block.title));
  end if;

  -- 毎週の定休 (2026-08 オーナー指示)。
  -- 「日曜の午後はスポーツ走行を受けない」のような、日付ではなく曜日で決まる決め事。
  -- ブロック予定と違って登録しっぱなしで効き続ける (毎年入れ直さなくてよい)。
  -- ★ 止めるのはスポーツ走行だけ。RP・貸切・ナイターは通常どおり受け付ける
  if p_kind = 'sport' and exists (
    select 1 from aone_weekly_sport_closed w
    where w.dow = extract(dow from p_date)::smallint and w.session = p_session
  ) then
    return jsonb_build_object('ok', false, 'reason', 'weekly_closed',
      'message', aone_weekday_ja(p_date) || 'の' ||
        case p_session when 'am' then '午前' else '午後' end ||
        'はスポーツ走行の受付をお休みしています',
      'detail', jsonb_build_object('dow', extract(dow from p_date)::int, 'session', p_session));
  end if;

  -- 確定済みの貸切 (仕様 5) — 貸切自体の判定は下で別に行う
  if p_kind <> 'charter' then
    select * into v_charter
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l
    where l.kind = 'charter' and l.status = 'confirmed'
    limit 1;
    if found then
      return jsonb_build_object('ok', false, 'reason', 'charter_confirmed',
        'message', 'この時間帯は貸切のため受付できません');
    end if;
  end if;

  -- ---- 種別ごとの判定 ----------------------------------------------------
  if p_kind = 'sport' then
    -- RP が閾値以上重なっている時間帯はスポーツ走行を止める (仕様 3)
    v_peak := aone_rp_peak_groups(p_date, v_start, v_end, p_exclude);
    if v_peak >= s.rp_groups_block_sport then
      return jsonb_build_object('ok', false, 'reason', 'rp_saturated',
        'message', 'レースパックが重なっているため、この時間帯のスポーツ走行は受付を停止しています',
        'detail', jsonb_build_object('rp_groups', v_peak));
    end if;

    -- クラス数 (同一カテゴリーは何台でも 1 クラス)
    select count(distinct r.category_code),
           bool_or(r.category_code = p_category)
      into v_classes, v_has_cat
    from aone_reservations r
    where r.date = p_date and r.kind = 'sport' and r.session = p_session
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    v_limit := case
      when aone_is_holiday(p_date) and p_session = 'am' then s.max_classes_holiday_am
      when aone_is_holiday(p_date) and p_session = 'pm' then s.max_classes_holiday_pm
      when p_session = 'am' then s.max_classes_weekday_am
      else s.max_classes_weekday_pm
    end;

    if coalesce(v_has_cat, false) then
      return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'existing_class',
        'message', '同じカテゴリーのクラスが既に受付済みのため、追加で受付できます',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    if coalesce(v_classes, 0) >= v_limit then
      return jsonb_build_object('ok', false, 'reason', 'class_full',
        'message', 'この時間帯の受付クラス数が上限に達しています',
        'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('classes', v_classes, 'limit', v_limit, 'rp_groups', v_peak));

  elsif p_kind = 'rp' then
    if p_start is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '開始時間を選択してください');
    end if;
    if coalesce(p_party, 0) < s.rp_min_party then
      return jsonb_build_object('ok', false, 'reason', 'min_party',
        'message', 'レースパックは ' || s.rp_min_party || ' 名以上で承ります');
    end if;
    if p_start < s.rp_first_start_time or p_start > s.rp_late_limit_time then
      return jsonb_build_object('ok', false, 'reason', 'out_of_hours',
        'message', 'レースパックの受付時間外です');
    end if;
    if extract(epoch from p_start)::int % (s.rp_slot_minutes * 60) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'bad_start_time',
        'message', '開始時間は ' || s.rp_slot_minutes || ' 分刻みで指定してください');
    end if;

    -- 当日の RP は準備とスタッフの都合で制限がきびしい (2026-08 オーナー確認)
    if p_date = aone_today() then
      if p_start >= s.rp_same_day_last_start then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_late',
          'message', '本日のレースパックは ' || to_char(s.rp_same_day_last_start, 'HH24:MI')
            || ' より前の開始のみ承ります。お電話でご相談ください');
      end if;
      if ((p_date + p_start) at time zone 'Asia/Tokyo')
           < now() + make_interval(mins => s.rp_same_day_lead_minutes) then
        return jsonb_build_object('ok', false, 'reason', 'rp_same_day_too_soon',
          'message', '本日のレースパックは ' || (s.rp_same_day_lead_minutes / 60)
            || ' 時間後以降のお時間でご予約ください。お急ぎの場合はお電話ください',
          'detail', jsonb_build_object('lead_minutes', s.rp_same_day_lead_minutes));
      end if;
    end if;

    -- 同一開始時刻のグループ数 (仕様 3)
    select count(*) into v_same_start
    from aone_reservations r
    where r.date = p_date and r.kind = 'rp' and r.start_time = p_start
      and aone_is_live(r.status)
      and (p_exclude is null or r.id <> p_exclude);

    if v_same_start >= s.rp_max_groups_per_start then
      return jsonb_build_object('ok', false, 'reason', 'rp_start_full',
        'message', 'この開始時間は既に ' || v_same_start || ' グループのご予約があります。別の時間をお選びください',
        'detail', jsonb_build_object('groups', v_same_start, 'limit', s.rp_max_groups_per_start));
    end if;

    -- 17:00 以降は要相談 (仕様 3)
    if p_start > s.rp_last_start_time then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'late_start',
        'message', to_char(s.rp_last_start_time, 'HH24:MI') || ' 以降の開始は要相談です。A-ONE より折り返しご連絡します',
        'detail', jsonb_build_object('groups', v_same_start));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', '受付できます',
      'detail', jsonb_build_object('groups', v_same_start));

  elsif p_kind = 'charter' then
    if p_start is null or p_end is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_request',
        'message', '貸切は開始・終了時間が必要です');
    end if;

    -- 当日の貸切は受けない (カートの準備が要る / 2026-08 オーナー確認)
    if p_date < aone_today() + s.charter_min_lead_days then
      return jsonb_build_object('ok', false, 'reason', 'charter_lead_time',
        'message', case when s.charter_min_lead_days = 1
          then '貸切は前日までのお申し込みとなります。当日はお電話でご相談ください'
          else '貸切は ' || s.charter_min_lead_days || ' 日前までのお申し込みとなります' end,
        'detail', jsonb_build_object('lead_days', s.charter_min_lead_days));
    end if;

    -- コース貸切のみ (レンタルカート無し) は都度見積り。必ず折り返す
    if p_charter = 'course_only' then
      return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'course_only',
        'message', 'コースのみの貸切は内容により料金が変わります。A-ONE より折り返しご連絡いたします');
    end if;

    -- 最小台数を下回る申込は受けない (レンタルカート付きのみ)
    if coalesce(p_vehicles, s.charter_min_karts) < s.charter_min_karts then
      return jsonb_build_object('ok', false, 'reason', 'charter_min_karts',
        'message', '貸切はカート ' || s.charter_min_karts || ' 台以上から承ります',
        'detail', jsonb_build_object('karts', p_vehicles, 'min', s.charter_min_karts));
    end if;

    -- 他予約があっても申込自体は受ける。ただし「連絡待ち」にする (仕様 5)
    select count(*) into v_others
    from aone_live_reservations_in_window(p_date, v_start, v_end, p_exclude) l;

    if v_others > 0 then
      return jsonb_build_object('ok', true, 'status', 'contact_wait', 'reason', 'other_reservations',
        'message', '既に他のご予約があるため、A-ONE よりご連絡いたします',
        'detail', jsonb_build_object('others', v_others));
    end if;

    return jsonb_build_object('ok', true, 'status', 'confirmed', 'reason', 'ok',
      'message', 'この時間帯は貸切をお受けできます',
      'detail', jsonb_build_object('others', 0));

  elsif p_kind = 'night' then
    -- ナイターは常に要相談 (仕様 6)
    return jsonb_build_object('ok', true, 'status', 'checking', 'reason', 'inquiry',
      'message', 'ナイター走行は事前予約・要相談です。A-ONE より折り返しご連絡します');
  end if;

  return jsonb_build_object('ok', false, 'reason', 'bad_request', 'message', '不明な予約種別です');
end;
$$;

alter function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  security definer set search_path = public, pg_temp;
grant execute on function aone_check_availability(text, date, text, text, time, time, integer, uuid, integer, text)
  to anon, authenticated, service_role;

-- ###########################################################################
-- # 0027_charter_price_by_hours.sql
-- ###########################################################################

-- =============================================================================
-- 貸切の料金に「時間」を入れる (2026-09 オーナー確認)
-- =============================================================================
-- これまでの式はカート台数だけを見ていた。
--
--   11,000 円 + 11,000 円 × 台数
--
-- そのため 13:00〜16:00 の 3 時間・10 台でも 121,000 円になっていた。
-- 実際の料金は利用時間でも変わる。正しい式は
--
--   11,000 円 + 台数 × 時間 × 11,000 円
--
--   例) 10 台 × 3 時間 = 11,000 + 10 × 3 × 11,000 = 341,000 円
--       5 台 × 1 時間  = 11,000 + 5 × 1 × 11,000  =  66,000 円 (これまでと同じ)
--
-- 時間は開始〜終了から数える。30 分などの端数は 1 時間に切り上げる
-- (コースを空けておく時間は同じなので、半端でも 1 時間分いただく)。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 利用時間 (1 時間単位・切り上げ)
-- -----------------------------------------------------------------------------
create or replace function aone_charter_hours(p_start time, p_end time)
returns integer
language sql immutable as $$
  select case
    when p_start is null or p_end is null or p_end <= p_start then 1
    else greatest(1, ceil(extract(epoch from (p_end - p_start)) / 3600.0)::integer)
  end;
$$;

comment on function aone_charter_hours(time, time) is
  '貸切の利用時間。30 分などの端数は 1 時間に切り上げる。時間が分からないときは 1 時間';

-- -----------------------------------------------------------------------------
-- 料金計算の本体
-- -----------------------------------------------------------------------------
-- 引数が増えるので、古い形は先に消す (残すと 2 つの関数が並び、
-- 呼び出し側によって古い式が使われてしまう)
drop function if exists aone_auto_amount(text, text, integer, integer);

create or replace function aone_auto_amount(
  p_kind       text,
  p_night_kind text,
  p_party      integer,
  p_vehicles   integer,
  p_start      time,
  p_end        time
) returns integer
language plpgsql stable as $$
declare
  s     aone_settings%rowtype;
  karts integer;
  hours integer;
  v_as  text;
begin
  select * into s from aone_settings where id = 1;

  -- ナイターは中身 (RP / 貸切) の料金で計算する
  v_as := case when p_kind = 'night' then p_night_kind else p_kind end;

  if v_as = 'rp' then
    return coalesce(p_party, 0) * s.rp_price_per_person;
  elsif v_as = 'charter' then
    -- 台数未指定なら最小台数で見積もる (確定時にスタッフが直す)
    karts := greatest(coalesce(p_vehicles, s.charter_min_karts), s.charter_min_karts);
    hours := aone_charter_hours(p_start, p_end);
    return s.charter_base_price + s.charter_price_per_kart * karts * hours;
  end if;

  return null;  -- スポーツ走行は料金体系が違うので入れない
end;
$$;

comment on function aone_auto_amount(text, text, integer, integer, time, time) is
  '自動計算の料金。RP = 人数 × 単価 / 貸切 = 基本料 + 単価 × 台数 × 時間';

-- 設定画面の項目名と意味がズレないように、列の意味を書き残す
comment on column aone_settings.charter_price_per_kart is
  '貸切のカート 1 台・1 時間あたりの料金';

-- -----------------------------------------------------------------------------
-- 呼び出し側 (トリガー) を新しい形に合わせる
-- -----------------------------------------------------------------------------
create or replace function aone_fill_amount() returns trigger
language plpgsql as $$
begin
  if new.amount is not null then
    new.amount_manual := true;   -- 明示的に渡された金額は尊重する
    return new;
  end if;
  -- コースのみの貸切は都度見積り。スタッフが金額を入れるまで空のままにする
  if new.charter_type = 'course_only' then
    return new;
  end if;
  new.amount := aone_auto_amount(new.kind, new.night_kind, new.party_size,
                                 new.vehicle_count, new.start_time, new.end_time);
  return new;
end;
$$;

drop trigger if exists aone_res_fill_amount on aone_reservations;
create trigger aone_res_fill_amount before insert on aone_reservations
  for each row execute function aone_fill_amount();

create or replace function aone_recalc_amount() returns trigger
language plpgsql as $$
declare
  v_auto integer;
begin
  -- コースのみの貸切は自動計算の対象外。入れた金額をそのまま尊重する
  if new.charter_type = 'course_only' then
    if new.amount is distinct from old.amount and new.amount is not null then
      new.amount_manual := true;
    end if;
    return new;
  end if;

  v_auto := aone_auto_amount(new.kind, new.night_kind, new.party_size,
                             new.vehicle_count, new.start_time, new.end_time);

  -- 自動計算と違う金額を入れた = 値引き等の意図がある。以後は上書きしない
  if new.amount is distinct from old.amount
     and new.amount is distinct from v_auto then
    new.amount_manual := true;
    return new;
  end if;

  -- 手入力された金額と、会計済みのものは触らない
  if new.amount_manual or new.is_paid then
    return new;
  end if;

  -- 自動計算のままの行。常に現在の内容から計算し直す
  -- (時間を変えた更新でも金額が追従する)
  if v_auto is not null then
    new.amount := v_auto;
  end if;

  return new;
end;
$$;

drop trigger if exists aone_res_recalc_amount on aone_reservations;
create trigger aone_res_recalc_amount before update on aone_reservations
  for each row execute function aone_recalc_amount();

-- -----------------------------------------------------------------------------
-- これから走る貸切の金額を、新しい式で入れ直す
-- -----------------------------------------------------------------------------
-- 済んだ日の予約は当時の金額で精算しているので触らない。
-- 手入力した金額 (値引き等) と会計済みも触らない。
-- 金額が変わった予約はお客様に伝わっていないので、管理画面の
-- 「変更をメールで送信」から連絡すること (§6.1)。
update aone_reservations r
set amount = aone_auto_amount(r.kind, r.night_kind, r.party_size,
                              r.vehicle_count, r.start_time, r.end_time)
where r.date >= aone_today()
  and r.status <> 'cancelled'
  and not r.amount_manual
  and not r.is_paid
  and coalesce(r.charter_type, '') <> 'course_only'
  and aone_auto_amount(r.kind, r.night_kind, r.party_size,
                       r.vehicle_count, r.start_time, r.end_time) is not null
  and r.amount is distinct from aone_auto_amount(r.kind, r.night_kind, r.party_size,
                                                 r.vehicle_count, r.start_time, r.end_time);

-- ###########################################################################
-- # 0028_event_files.sql
-- ###########################################################################

-- =============================================================================
-- イベントの資料 (エントリーリスト・タイムスケジュールの PDF) を預かる
-- =============================================================================
-- エントリーリストとタイムスケジュールは A-ONE 側で PDF を作るので、それを
-- 管理画面からアップロードして、お客様に見せられるようにする (2026-09 オーナー確認)。
--
-- 置き場所は**この表**にする。理由:
--   ・新しいサービス (ストレージ) を増やさない。設定する場所が増えると、
--     どこに何があるか分からなくなるし、鍵の管理も増える
--   ・毎日のバックアップにそのまま乗る
--   ・PDF は数百 KB。イベント 1 つにつき数枚なので、大きさの心配はない
--
-- 中身は base64 の文字列で持つ。取り出しは /files/event/<id> が行う
-- (この表は anon から直接は読めない。公開してよいものだけを配る)。
-- =============================================================================

create table if not exists aone_event_files (
  id          uuid primary key default gen_random_uuid(),
  block_id    uuid not null references aone_blocks(id) on delete cascade,
  kind        text not null default 'other'
                check (kind in ('entry_list', 'timetable', 'rules', 'vehicle_rules', 'result', 'other')),
  title       text not null,
  file_name   text not null,
  mime        text not null default 'application/pdf',
  size_bytes  integer not null check (size_bytes > 0),
  data        text not null,          -- base64
  is_public   boolean not null default true,
  sort_order  smallint not null default 0,
  uploaded_at timestamptz not null default now()
);

comment on table aone_event_files is
  'イベントの配布資料 (PDF)。中身は base64。配るのは /files/event/<id>';
comment on column aone_event_files.kind is
  'entry_list = エントリーリスト / timetable = タイムスケジュール / rules = 特別規則書 / vehicle_rules = 車輌規則 / result = リザルト';
comment on column aone_event_files.is_public is
  'false にすると公開ページから消える (差し替え中など)。消さずに隠せる';

create index if not exists aone_event_files_block_idx
  on aone_event_files (block_id, sort_order, uploaded_at);

-- -----------------------------------------------------------------------------
-- 資料の一覧 (中身は返さない)
-- -----------------------------------------------------------------------------
-- data まで返すと一覧を開くだけで何 MB も流れる。一覧に要るのは名前と大きさだけ。
create or replace function aone_event_file_list(p_block_id uuid, p_all boolean default false)
returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'sort_order', x->>'uploaded_at'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', f.id,
      'kind', f.kind,
      'title', f.title,
      'file_name', f.file_name,
      'size_bytes', f.size_bytes,
      'is_public', f.is_public,
      'sort_order', f.sort_order,
      'uploaded_at', to_char(f.uploaded_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI'),
      'url', '/files/event/' || f.id
    ) as x
    from aone_event_files f
    where f.block_id = p_block_id
      and (p_all or f.is_public)
  ) y;
$$;

-- -----------------------------------------------------------------------------
-- 受付中イベントの一覧に資料を足す
-- -----------------------------------------------------------------------------
-- 申込ページで「タイムスケジュールを見る」を出せるようにする。
create or replace function aone_open_events() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'date'), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', b.id,
      'date', to_char(b.date, 'YYYY-MM-DD'),
      'title', coalesce(nullif(b.public_label, ''), b.title),
      'kind', b.kind,
      'entry_type', b.entry_type,
      'price', b.entry_price,
      'unit', b.entry_unit,
      'deadline', to_char(coalesce(b.entry_deadline, b.date - 1), 'YYYY-MM-DD'),
      'rules_url', nullif(b.entry_rules_url, ''),
      'vehicle_rules_url', nullif(b.entry_vehicle_rules_url, ''),
      'classes', to_jsonb(b.entry_classes),
      'note', nullif(b.entry_note, ''),
      'files', aone_event_file_list(b.id),
      'entries', (select count(*) from aone_event_entries e
                   where e.block_id = b.id and e.status <> 'cancelled')
    ) as x
    from aone_blocks b
    where b.entry_open
      and b.entry_type is not null
      and coalesce(b.entry_deadline, b.date - 1) >= aone_today()
  ) y;
$$;

alter function aone_open_events() security definer set search_path = public, pg_temp;
grant execute on function aone_open_events() to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1 つのイベントを公開向けに読む (資料ページ用)
-- -----------------------------------------------------------------------------
-- 受付が終わったイベントでも、資料 (リザルト等) は見せたいので締切では絞らない。
-- 予定として公開していないものは出さない。
create or replace function aone_public_event(p_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', b.id,
    'date', to_char(b.date, 'YYYY-MM-DD'),
    'title', coalesce(nullif(b.public_label, ''), b.title),
    'kind', b.kind,
    'start_time', to_char(b.start_time, 'HH24:MI'),
    'end_time', to_char(b.end_time, 'HH24:MI'),
    'entry_open', b.entry_open,
    'entry_type', b.entry_type,
    'price', b.entry_price,
    'unit', b.entry_unit,
    'deadline', to_char(coalesce(b.entry_deadline, b.date - 1), 'YYYY-MM-DD'),
    'accepting', b.entry_open and b.entry_type is not null
                 and coalesce(b.entry_deadline, b.date - 1) >= aone_today(),
    'rules_url', nullif(b.entry_rules_url, ''),
    'vehicle_rules_url', nullif(b.entry_vehicle_rules_url, ''),
    'classes', to_jsonb(b.entry_classes),
    'note', nullif(b.entry_note, ''),
    'files', aone_event_file_list(b.id)
  )
  from aone_blocks b
  where b.id = p_id and b.is_public;
$$;

alter function aone_event_file_list(uuid, boolean) security definer set search_path = public, pg_temp;
alter function aone_public_event(uuid) security definer set search_path = public, pg_temp;
grant execute on function aone_event_file_list(uuid, boolean) to anon, authenticated, service_role;
grant execute on function aone_public_event(uuid) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 権限
-- -----------------------------------------------------------------------------
-- 中身 (data) は anon に触らせない。配るのは /files/event/<id> だけ。
alter table aone_event_files enable row level security;

-- ⚠ 0005 の grant は当時あった表にしか効かない。新しい表には個別に要る
grant all on aone_event_files to service_role;
