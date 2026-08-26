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
