-- ローカル Postgres 用テスト。本番 (Supabase) では実行しない (rollback するが念のため)。
--   psql -v ON_ERROR_STOP=1 -f 0001_initial_schema.sql
--   psql -v ON_ERROR_STOP=1 -f _TEST_photo.sql      → 最後に ALL TESTS PASSED
begin;

create or replace function t_assert(p_ok boolean, p_name text) returns void language plpgsql as $$
begin if not p_ok then raise exception 'FAILED: %', p_name; end if; end $$;

-- 例外が出ることを確認する (部分トランザクションで包む)
create or replace function t_raises(p_sql text, p_expect text, p_name text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when others then
    if sqlerrm like p_expect || '%' then return; end if;
    raise exception 'FAILED: % (got: %)', p_name, sqlerrm;
  end;
  raise exception 'FAILED: % (no error)', p_name;
end $$;

-- ---- トークン ---------------------------------------------------------------
select t_assert(length(photo_new_token()) = 22, 'token length 22');
select t_assert(photo_new_token() <> photo_new_token(), 'token random');

-- ---- 価格 (500 / 1000 / 2000) ----------------------------------------------
select t_assert((select amount from photo_calc_price(1, 80)) = 500,  'price 1');
select t_assert((select amount from photo_calc_price(2, 80)) = 1000, 'price 2');
select t_assert((select amount from photo_calc_price(3, 80)) = 1000, 'price 3');
select t_assert((select amount from photo_calc_price(4, 80)) = 1500, 'price 4');
select t_assert((select amount from photo_calc_price(5, 80)) = 2000 and (select pack from photo_calc_price(5, 80)), 'price 5 -> pack');
select t_assert((select amount from photo_calc_price(40, 80)) = 2000 and (select pack from photo_calc_price(40, 80)), 'price 40 -> pack');
-- 残りが選択数より少なければパックにしない (ありえないが安全側)
select t_assert(not (select pack from photo_calc_price(6, 5)), 'no pack when n > remaining');
select t_raises('select * from photo_calc_price(0, 5)', 'empty_selection', 'price 0');
-- 価格を設定で変えられる
update settings set value = '{"single":600,"set3":1200,"pack":2500}' where key = 'prices';
select t_assert((select amount from photo_calc_price(3, 80)) = 1200, 'price follows settings');
update settings set value = '{"single":500,"set3":1000,"pack":2000}' where key = 'prices';

-- ---- 同意による公開制御 ------------------------------------------------------
insert into groups(id, qr_token, name, headcount) values
  ('00000000-0000-0000-0000-0000000000a1', 'TOKEN_A', 'A団体', 5),
  ('00000000-0000-0000-0000-0000000000b1', 'TOKEN_B', 'B団体', 4);

select t_assert(not (select online_ok from groups where qr_token='TOKEN_A'), 'no consent -> not online_ok');
select t_raises($$update groups set status='published' where qr_token='TOKEN_A'$$,
                'new row for relation "groups" violates check constraint', 'cannot publish without consent');

-- 未成年を含み、保護者同意が無い → 公開不可
update groups set consent_shoot=true, consent_online=true, consent_tv=true, has_minor=true where qr_token='TOKEN_A';
select t_assert(not (select online_ok from groups where qr_token='TOKEN_A'), 'minor w/o guardian -> not online_ok');
select t_assert(not (select tv_ok from groups where qr_token='TOKEN_A'), 'minor w/o guardian -> not tv_ok');
update groups set guardian_consent=true where qr_token='TOKEN_A';
select t_assert((select online_ok and tv_ok from groups where qr_token='TOKEN_A'), 'guardian consent -> ok');

-- TV とオンラインは別管理
update groups set consent_tv=false where qr_token='TOKEN_A';
select t_assert((select online_ok and not tv_ok from groups where qr_token='TOKEN_A'), 'tv separate from online');
update groups set status='published', published_at=now() where qr_token='TOKEN_A';

-- B は同意なし → 公開されない
select t_raises($$select * from photo_create_pending_order('TOKEN_B', array[]::uuid[], 'x@example.com')$$,
                'group_not_available', 'unpublished group cannot be bought');

-- ---- 写真 ------------------------------------------------------------------
insert into photos(id, group_id, sha256, original_key, preview_key, thumb_key, taken_at)
select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-0000000000a1', 'sha' || n, 'o/' || n, 'p/' || n, 't/' || n,
       now() + n * interval '1 second'
from generate_series(1, 10) n;
-- 別グループの写真
insert into photos(id, group_id, sha256, original_key, preview_key, thumb_key)
values ('00000000-0000-0000-0000-0000000000ff','00000000-0000-0000-0000-0000000000b1','shaX','o/x','p/x','t/x');

-- 重複アップロード防止
select t_raises($$insert into photos(group_id, sha256, original_key, preview_key, thumb_key)
  values ('00000000-0000-0000-0000-0000000000a1','sha1','o','p','t')$$,
  'duplicate key value violates unique constraint "photos_group_sha_uq"', 'duplicate sha');

-- ---- 注文 ------------------------------------------------------------------
select t_raises($$select * from photo_create_pending_order('NOPE', array[]::uuid[], 'x@example.com')$$, 'group_not_available', 'bad token');
select t_raises($$select * from photo_create_pending_order('TOKEN_A', array['00000000-0000-0000-0000-000000000001']::uuid[], '')$$, 'email_required', 'email required');
-- 別グループの写真は買えない (QR を知っていても他団体は見えない)
select t_raises($$select * from photo_create_pending_order('TOKEN_A', array['00000000-0000-0000-0000-0000000000ff']::uuid[], 'x@example.com')$$,
                'photo_not_available', 'foreign photo');

create temp table o1 as select * from photo_create_pending_order('TOKEN_A',
  array['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003']::uuid[],
  'a@example.com');
select t_assert((select amount_jpy from o1) = 1000 and not (select pack_applied from o1), '3 photos = 1000');

-- 決済前は購入済みにならない → 同じ写真の注文がもう 1 本作れてしまう (競合の再現用)
create temp table o2 as select * from photo_create_pending_order('TOKEN_A',
  array['00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004']::uuid[], 'b@example.com');

select t_assert(photo_finalize_order((select order_id from o1), 'pi_1', 1000) = 'paid', 'finalize o1');
select t_assert(photo_finalize_order((select order_id from o1), 'pi_1', 1000) = 'paid', 'finalize idempotent');
select t_assert((select download_expires_at from orders where id=(select order_id from o1)) > now(), 'download expiry set');

-- 先に確定した写真 (#3) を含む注文は、決済されても確定せず要確認になる (二重決済)
select t_assert(photo_finalize_order((select order_id from o2), 'pi_2', 1000) = 'needs_review', 'duplicate payment -> needs_review');
select t_assert((select review_reason from orders where id=(select order_id from o2)) = 'duplicate_purchase', 'review reason');
select t_assert(not exists (select 1 from order_items where order_id=(select order_id from o2) and counted),
                'needs_review order grants nothing');

-- 購入済みの写真は新しい注文に入れられない
select t_raises($$select * from photo_create_pending_order('TOKEN_A', array['00000000-0000-0000-0000-000000000001']::uuid[], 'c@example.com')$$,
                'already_purchased', 'already purchased');

-- 金額不一致は要確認
create temp table o3 as select * from photo_create_pending_order('TOKEN_A',
  array['00000000-0000-0000-0000-000000000005']::uuid[], 'c@example.com');
select t_assert(photo_finalize_order((select order_id from o3), 'pi_3', 999) = 'needs_review', 'amount mismatch');

-- 全写真パック = 購入可能な残り全部 (#1-3 は購入済みなので 7 枚)
create temp table o4 as select * from photo_create_pending_order('TOKEN_A', null, 'd@example.com', true);
select t_assert((select amount_jpy from o4) = 2000 and (select pack_applied from o4) and (select photo_count from o4) = 7,
                'pack = all remaining (7) at 2000');
select t_assert(photo_finalize_order((select order_id from o4), 'pi_4', 2000) = 'paid', 'finalize pack');
-- 全部売れたあとは何も買えない
select t_raises($$select * from photo_create_pending_order('TOKEN_A', null, 'e@example.com', true)$$, 'empty_selection', 'nothing left');

-- 分析ビュー
select t_assert((select paid_orders from v_group_sales where name='A団体') = 2, 'paid orders in view');
select t_assert((select revenue_jpy from v_group_sales where name='A団体') = 3000, 'revenue in view');
select t_assert((select pack_orders from v_group_sales where name='A団体') = 1, 'pack orders in view');
select t_assert((select needs_review_orders from v_group_sales where name='A団体') = 2, 'needs_review in view');
select t_assert((select revenue_per_head_jpy from v_group_sales where name='A団体') = 600, 'revenue per head');

-- 返金すると写真が買い直せる
select photo_refund_order_full((select order_id from o1), 're_1', null, 'test');
select t_assert((select status from orders where id=(select order_id from o1)) = 'refunded', 'refunded');
select t_assert((select count(*) from photo_remaining_ids('00000000-0000-0000-0000-0000000000a1')) = 3, 'refund frees photos');

-- ---- 保存期間 ---------------------------------------------------------------
-- 撮影日が 31 日前 → 未購入写真は削除対象、購入済みは preview_only
update groups set shoot_date = photo_today() - 31 where qr_token='TOKEN_A';
select t_assert(exists (select 1 from photos_to_purge() where photo_id='00000000-0000-0000-0000-000000000001' and purge_kind='all'),
                'refunded (unpurchased) photo purged after 31d');
select t_assert(exists (select 1 from photos_to_purge() where photo_id='00000000-0000-0000-0000-000000000004' and purge_kind='preview_only'),
                'purchased photo: preview only after view window');
-- 撮影日が 10 日前 → まだ何も消えない
update groups set shoot_date = photo_today() - 10 where qr_token='TOKEN_A';
select t_assert(not exists (select 1 from photos_to_purge()), 'nothing purged within window');
-- グループを削除状態にすると全消去
update groups set status='deleted' where qr_token='TOKEN_A';
select t_assert((select count(*) from photos_to_purge() where purge_kind='all') = 10, 'deleted group purges all');

-- 古い pending 注文の失効
update orders set created_at = now() - interval '3 hours', status='pending' where id=(select order_id from o3);
select t_assert(photo_expire_pending_orders(120) = 1, 'expire pending');

-- ---- RLS ------------------------------------------------------------------
select t_assert((select bool_and(relrowsecurity) from pg_class
   where relname in ('groups','photos','orders','order_items','settings','staff_users','audit_logs','refunds')), 'RLS enabled');

select 'ALL TESTS PASSED' as result;
rollback;
