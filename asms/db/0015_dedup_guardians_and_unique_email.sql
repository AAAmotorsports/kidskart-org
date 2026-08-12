-- 0015_dedup_guardians_and_unique_email.sql
--
-- 問題:
--   guardians に同一 email の行が複数存在。Phase 1 初期実装で dedup が
--   甘かった時期の遺産。0012 の create_reservation_atomic 導入後は
--   新規に増えないが、既存の重複が Magic Link のプリフィルを壊す:
--   auth_user_id が特定の 1 行にしか紐付かないため、過去予約が別行に
--   紐付いていると参加者履歴が空で返る。
--
-- 対処:
--   1. email 毎に 1 行を canonical（auth_user_id 有り優先、次に古い順）
--   2. reservations / guardian_customer_links を canonical に再ポイント
--   3. auth_user_id は victim 側にあれば canonical へ引き継ぐ
--   4. victim を DELETE
--   5. guardians.email に UNIQUE 制約追加（今後の重複を DB 側で阻止）
--
-- 事前に BEGIN / COMMIT で包み、途中失敗したら全てロールバック。

begin;

-- 統合マップ: victim_id → keep_id + victim の auth_user_id
create temp table _guardian_dedup_map on commit drop as
with ranked as (
  select id, email, created_at, auth_user_id,
         row_number() over (
           partition by email
           order by (auth_user_id is not null) desc,  -- 紐付け済を優先
                    created_at asc                     -- 次に最古
         ) as rn
    from guardians
),
canonical as (
  select email, id as keep_id from ranked where rn = 1
)
select r.id as victim_id, c.keep_id, r.auth_user_id as victim_auth
  from ranked r
  join canonical c on c.email = r.email
 where r.rn > 1;

-- victim 側の auth_user_id を canonical に引き継ぐ（canonical が null の時のみ）
update guardians g
   set auth_user_id = sub.victim_auth
  from (
    select distinct on (keep_id) keep_id, victim_auth
      from _guardian_dedup_map
     where victim_auth is not null
     order by keep_id, victim_auth
  ) sub
 where g.id = sub.keep_id
   and g.auth_user_id is null;

-- reservations を canonical に再ポイント
update reservations
   set guardian_id = m.keep_id
  from _guardian_dedup_map m
 where reservations.guardian_id = m.victim_id;

-- guardian_customer_links: (guardian_id, customer_id) UNIQUE のため
-- 事前に canonical 側と重複するリンクを削除
delete from guardian_customer_links l
 where exists (
   select 1
     from _guardian_dedup_map m
    where l.guardian_id = m.victim_id
      and exists (
        select 1 from guardian_customer_links l2
         where l2.guardian_id = m.keep_id
           and l2.customer_id = l.customer_id
      )
 );

-- 残りを canonical に再ポイント
update guardian_customer_links
   set guardian_id = m.keep_id
  from _guardian_dedup_map m
 where guardian_customer_links.guardian_id = m.victim_id;

-- victim 削除
delete from guardians
 where id in (select victim_id from _guardian_dedup_map);

-- email UNIQUE 制約（CITEXT なので大文字小文字は同一視される）
alter table guardians
  add constraint guardians_email_unique unique (email);

commit;
