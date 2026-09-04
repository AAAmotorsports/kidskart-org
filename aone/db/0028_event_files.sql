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
