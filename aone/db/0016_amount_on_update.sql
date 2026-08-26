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
