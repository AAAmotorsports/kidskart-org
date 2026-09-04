-- =============================================================================
-- レンタルのキャンセル規定を改定 (2026-09 オーナー確認)
-- =============================================================================
-- これまで: 連絡さえあれば、当日でも種別を問わずキャンセル料なし。
--           料金 100% は無断キャンセル (連絡なし) だけ。
--
-- これから: レンタル (レースパック・貸切・ナイター) は
--   ・前日 18 時までのご連絡 … 無料
--   ・それ以降 (当日を含む)  … 料金の 50%
--   ・連絡なし (無断)        … 料金の 100%
--
-- 持ち込みのスポーツ走行は天候の影響が大きいので、これまでどおり
-- 連絡があれば当日でも無料 (無断キャンセルだけ 100%)。
--
-- 画面とメールの文面は app/src/lib/domain.ts の CANCEL_POLICY_* に置いてある。
-- **ここと文面がズレるとお客様との行き違いになる**ので、片方を直したら
-- もう片方も直すこと。
-- =============================================================================

create or replace function aone_cancel_reservation(payload jsonb) returns jsonb
language plpgsql volatile as $$
declare
  v_row      aone_reservations%rowtype;
  v_no_show  boolean := coalesce((payload->>'no_show')::boolean, false);
  v_deadline timestamp;   -- 前日 18 時 (JST)
  v_rate     integer;     -- 発生するキャンセル料の割合 (0 / 50 / 100)
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
                              'already', true, 'cancel_fee', false, 'cancel_fee_rate', 0);
  end if;

  v_deadline := (v_row.date - 1) + time '18:00';
  v_rate := case
    when v_no_show then 100
    -- スポーツ走行は天候の影響が大きい。連絡があれば当日でも無料
    when v_row.kind = 'sport' then 0
    when (now() at time zone 'Asia/Tokyo') <= v_deadline then 0
    else 50
  end;

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
          jsonb_build_object('reason', payload->>'reason',
                             'cancel_fee', v_rate > 0, 'cancel_fee_rate', v_rate));

  return jsonb_build_object(
    'ok', true,
    'id', v_row.id,
    'reservation_number', v_row.reservation_number,
    'status', v_row.status,
    'kind', v_row.kind,
    'date', to_char(v_row.date, 'YYYY-MM-DD'),
    'cancel_fee', v_rate > 0,
    -- 何 % かは画面とメールで書き分けるので、割合そのものも返す
    'cancel_fee_rate', v_rate
  );
end;
$$;

alter function aone_cancel_reservation(jsonb) security definer set search_path = public, pg_temp;
grant execute on function aone_cancel_reservation(jsonb) to anon, authenticated, service_role;
