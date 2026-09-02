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
