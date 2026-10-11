-- 0038_recalculate_reservation_total.sql
--
-- 予約の total_amount をアクティブ参加者数ベースで原子的に再計算する RPC。
--
-- 【動機】
-- /api/reserve/cancel.ts と /admin/slots/[id].astro (cancel_participant op) の
-- 両方が「SELECT 現在のアクティブ参加者 → JS で合計計算 → UPDATE total_amount」
-- という TOCTOU 競合しうるパターンだった。
-- 同時に 2 人分キャンセルすると、両者が同じ "残り N 人" を読んで両方とも
-- (N-1)×price を書き、最終的な total_amount が 1 席分ズレる。
--
-- 【解決】
-- 単一トランザクション内で:
--   1. SELECT FOR UPDATE で reservations 行を lock
--   2. 同一予約の active 参加者数を COUNT
--   3. slots/courses から price_tier に応じた単価を取得
--   4. UPDATE total_amount
-- アプリ側は participant.attendance_status を書き換えた後、この RPC を呼ぶだけ。
-- 2 並列で呼ばれても後者は前者の UPDATE 後の値を読むので正しくなる。
--
-- 【注意】
-- - active = attendance_status IN ('expected', 'attended', 'no_show')
--   = NOT cancelled。 "no_show でも料金は請求" 慣行に合わせる。
-- - 価格は courses.price_regular / price_member を reservations.price_tier で切替。
-- - 戻り値は新しい total_amount。アプリは即 UI 更新に使える。
-- - 対象予約が cancelled の場合も計算して返す (ゼロではない。
--   アクティブ 0 なら 0 になる)。
--
-- 本 SQL の実行は アプリ deploy の前後どちらでも可。

create or replace function recalculate_reservation_total(p_reservation_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_tier         text;
  v_slot_id      uuid;
  v_per_person   integer;
  v_active_count integer;
  v_new_total    integer;
begin
  -- 1) 対象予約を lock
  select price_tier, slot_id
    into v_tier, v_slot_id
    from reservations
   where id = p_reservation_id
   for update;
  if not found then
    raise exception 'reservation not found: %', p_reservation_id
      using errcode = 'PGRSN', hint = 'reservation_not_found';
  end if;

  -- 2) 単価を取得 (member or regular)
  select case when v_tier = 'member'
              then c.price_member
              else c.price_regular
         end
    into v_per_person
    from slots s
    join courses c on c.id = s.course_id
   where s.id = v_slot_id;
  if v_per_person is null then
    v_per_person := 0;
  end if;

  -- 3) active 参加者数
  select count(*)
    into v_active_count
    from reservation_participants
   where reservation_id = p_reservation_id
     and attendance_status <> 'cancelled';

  v_new_total := v_active_count * v_per_person;

  -- 4) UPDATE
  update reservations
     set total_amount = v_new_total
   where id = p_reservation_id;

  return v_new_total;
end;
$$;

comment on function recalculate_reservation_total(uuid) is
  '予約の total_amount をアクティブ参加者数 × 単価で原子的に再計算 (SELECT FOR UPDATE で TOCTOU 回避)。';

-- 匿名ロールにも execute 権限を付けておく (API 側で呼ぶため)
grant execute on function recalculate_reservation_total(uuid) to anon, authenticated, service_role;
