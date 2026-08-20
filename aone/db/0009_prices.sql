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
