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
