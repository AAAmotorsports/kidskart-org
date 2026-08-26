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
