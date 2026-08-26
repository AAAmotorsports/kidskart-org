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
