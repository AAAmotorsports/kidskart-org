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
