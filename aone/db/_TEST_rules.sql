-- =============================================================================
-- A-ONE ルールエンジンのテスト (ローカル Postgres 用)
-- =============================================================================
-- 使い方 (ローカルに空の DB を用意して):
--   psql -f 0001_initial_schema.sql -f 0002_seed_holidays.sql \
--        -f 0003_availability_engine.sql -f 0004_reservation_rpcs.sql
--   psql -v ON_ERROR_STOP=1 -f _TEST_rules.sql
--
-- 全部通れば最後に「ALL TESTS PASSED」と出る。
-- 本番 (Supabase) では実行しないこと — テストデータを作って rollback する。
-- =============================================================================
begin;

-- テスト用の基準日: 次の平日 (月〜金) と 次の日曜
create temp table t_dates as
select
  (select d from generate_series(aone_today() + 1, aone_today() + 14, interval '1 day') g(d)
    where extract(dow from d) between 1 and 5 and not aone_is_holiday(d::date) limit 1)::date as weekday,
  (select d from generate_series(aone_today() + 1, aone_today() + 14, interval '1 day') g(d)
    where extract(dow from d) = 0 limit 1)::date as sunday,
  -- 2 つめの平日 (先の平日と別日にしたいケース用)
  (select d from generate_series(aone_today() + 6, aone_today() + 20, interval '1 day') g(d)
    where extract(dow from d) between 1 and 5 and not aone_is_holiday(d::date) limit 1)::date as weekday2;

create or replace function t_book(p jsonb) returns jsonb language sql volatile as $$
  select aone_create_reservation(
    p || jsonb_build_object('contact', jsonb_build_object(
      'name', coalesce(p->>'who', 'テスト太郎'),
      'phone', coalesce(p->>'phone', '090-0000-0000'),
      'email', coalesce(p->>'email', '')))
  );
$$;

do $$
declare
  d_weekday date;
  d_sunday  date;
  d_wd2     date;
  r  jsonb;
  st jsonb;
  ok boolean;
  msg text;
  id1 uuid;
begin
  select weekday, sunday, weekday2 into d_weekday, d_sunday, d_wd2 from t_dates;

  -- =========================================================================
  raise notice '--- 1. スポーツ走行: 平日は 2 クラスまで、同一カテゴリーは何台でも 1 クラス';
  -- =========================================================================
  r := t_book(jsonb_build_object('kind','sport','date',d_weekday,'session','am',
                                 'category_code','kart','party_size',2,'who','カートA'));
  assert (r->>'status') = 'confirmed', '1-1 カート1件目が確定しない: ' || r::text;

  -- 同一カテゴリー2件目 → 1 クラス扱いなので通る
  r := t_book(jsonb_build_object('kind','sport','date',d_weekday,'session','am',
                                 'category_code','kart','party_size',1,'who','カートB'));
  assert (r->>'status') = 'confirmed', '1-2 同一カテゴリー追加が弾かれた';
  assert (r->'check'->>'reason') = 'existing_class', '1-2 reason が existing_class でない';

  -- 2 クラス目 (別カテゴリー) → 通る
  r := t_book(jsonb_build_object('kind','sport','date',d_weekday,'session','am',
                                 'category_code','minibike','party_size',1,'who','バイクA'));
  assert (r->>'status') = 'confirmed', '1-3 2クラス目が弾かれた';

  -- 3 クラス目 → 上限で弾かれる
  begin
    r := t_book(jsonb_build_object('kind','sport','date',d_weekday,'session','am',
                                   'category_code','kidskart','party_size',1,'who','キッズA'));
    assert false, '1-4 3クラス目が受け付けられてしまった';
  exception when sqlstate 'AONE1' then
    get stacked diagnostics msg = pg_exception_hint;
    assert msg = 'class_full', '1-4 hint が class_full でない: ' || msg;
  end;

  -- 午後は別枠なので空いている
  r := aone_check_availability('sport', d_weekday, 'kidskart', 'pm');
  assert (r->>'ok')::boolean, '1-5 午後まで塞がっている';

  -- 「今日走れる？」表示: 午前のキッズは closed、カートは open (既存クラス)
  st := aone_day_state(d_weekday);
  assert (st->'sport'->'am'->'categories'->2->>'status') = 'closed', '1-6 キッズが closed でない';
  assert (st->'sport'->'am'->'categories'->0->>'status') = 'open',   '1-6 カートが open でない';
  assert (st->'sport'->'am'->>'used_classes') = '2', '1-6 used_classes が 2 でない';

  -- =========================================================================
  raise notice '--- 2. 土日祝の午後は 1 クラスまで';
  -- =========================================================================
  r := t_book(jsonb_build_object('kind','sport','date',d_sunday,'session','pm',
                                 'category_code','kart','party_size',1,'who','日曜カート'));
  assert (r->>'status') = 'confirmed', '2-1 日曜午後 1 クラス目が弾かれた';
  begin
    r := t_book(jsonb_build_object('kind','sport','date',d_sunday,'session','pm',
                                   'category_code','minibike','party_size',1,'who','日曜バイク'));
    assert false, '2-2 日曜午後 2 クラス目が受け付けられてしまった';
  exception when sqlstate 'AONE1' then
    get stacked diagnostics msg = pg_exception_hint;
    assert msg = 'class_full', '2-2 hint が class_full でない: ' || msg;
  end;
  -- 日曜午前は 2 クラス
  r := aone_check_availability('sport', d_sunday, 'minibike', 'am');
  assert (r->>'ok')::boolean, '2-3 日曜午前が受け付けられない';
  st := aone_day_state(d_sunday);
  assert (st->'sport'->'pm'->>'max_classes') = '1', '2-4 日曜午後の上限が 1 でない';
  assert (st->'sport'->'am'->>'max_classes') = '2', '2-4 日曜午前の上限が 2 でない';

  -- =========================================================================
  raise notice '--- 3. RP: 3 名以上 / 同一開始時刻は 2 グループまで';
  -- =========================================================================
  begin
    r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','14:00',
                                   'party_size',2,'who','RP少人数'));
    assert false, '3-1 2 名の RP が受け付けられてしまった';
  exception when sqlstate 'AONE1' then
    get stacked diagnostics msg = pg_exception_hint;
    assert msg = 'min_party', '3-1 hint が min_party でない: ' || msg;
  end;

  r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','14:00',
                                 'party_size',5,'who','RP-A'));
  assert (r->>'status') = 'confirmed', '3-2 RP 1 組目が確定しない';
  assert (r->>'end_time') = '15:30', '3-2 終了時刻が自動計算されていない: ' || (r->>'end_time');

  r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','14:00',
                                 'party_size',4,'who','RP-B'));
  assert (r->>'status') = 'confirmed', '3-3 RP 2 組目が確定しない';

  begin
    r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','14:00',
                                   'party_size',3,'who','RP-C'));
    assert false, '3-4 同一開始時刻の 3 組目が受け付けられてしまった';
  exception when sqlstate 'AONE1' then
    get stacked diagnostics msg = pg_exception_hint;
    assert msg = 'rp_start_full', '3-4 hint が rp_start_full でない: ' || msg;
  end;

  -- 30 分ずらせば受付できる (RP をできるだけ受ける設計 — 仕様 3)
  r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','14:30',
                                 'party_size',3,'who','RP-C2'));
  assert (r->>'status') = 'confirmed', '3-5 30 分ずらした RP が弾かれた';

  -- 17:00 以降は要相談 (受け付けるが確認中)
  r := t_book(jsonb_build_object('kind','rp','date',d_weekday,'start_time','17:30',
                                 'party_size',3,'who','RP-夕方'));
  assert (r->>'status') = 'checking', '3-6 17:30 開始が確認中にならない: ' || r::text;

  -- =========================================================================
  raise notice '--- 4. RP が 3 グループ重なった時間帯はスポーツ走行を停止';
  -- =========================================================================
  -- 14:00 / 14:00 / 14:30 の 3 グループが 14:30〜15:30 に重なっている
  assert aone_rp_peak_groups(d_weekday, '13:00', '16:30') >= 3,
    '4-1 RP ピークが 3 に達していない';
  r := aone_check_availability('sport', d_weekday, 'kidskart', 'pm');
  assert not (r->>'ok')::boolean, '4-2 RP 3 組でもスポーツが受付できてしまう';
  assert (r->>'reason') = 'rp_saturated', '4-2 reason が rp_saturated でない: ' || (r->>'reason');
  -- 午前は影響を受けない
  r := aone_check_availability('sport', d_weekday, 'kidskart', 'am');
  assert (r->>'reason') <> 'rp_saturated', '4-3 午前まで停止している';

  -- =========================================================================
  raise notice '--- 5. 貸切: 他予約が無ければ確定、あれば連絡待ち';
  -- =========================================================================
  r := t_book(jsonb_build_object('kind','charter','date',d_weekday,'start_time','13:00',
                                 'end_time','16:00','party_size',10,
                                 'preferred_contact','phone','who','貸切A'));
  assert (r->>'status') = 'contact_wait', '5-1 他予約ありの貸切が連絡待ちにならない: ' || r::text;

  -- 予約が 1 件も無い日 (+13 日) の貸切は確定
  r := t_book(jsonb_build_object('kind','charter','date', aone_today() + 13,
                                 'start_time','09:00','end_time','12:00','party_size',8,
                                 'preferred_contact','email','who','貸切B'));
  assert (r->>'status') = 'confirmed', '5-2 空き日の貸切が確定しない: ' || r::text;
  id1 := (r->>'id')::uuid;

  -- 確定貸切の時間帯はスポーツも RP も停止
  r := aone_check_availability('sport', aone_today() + 13, 'kart', 'am');
  assert (r->>'reason') = 'charter_confirmed', '5-3 貸切中にスポーツが受付できてしまう';
  r := aone_check_availability('rp', aone_today() + 13, null, null, '10:00', null, 4);
  assert (r->>'reason') = 'charter_confirmed', '5-4 貸切中に RP が受付できてしまう';
  -- 午後は空いている
  r := aone_check_availability('sport', aone_today() + 13, 'kart', 'pm');
  assert (r->>'ok')::boolean, '5-5 貸切の時間外まで止まっている';

  -- =========================================================================
  raise notice '--- 6. ブロック予定 (レース / イベント / 臨時休業)';
  -- =========================================================================
  insert into aone_blocks (date, kind, title, scope)
  values (aone_today() + 10, 'race', 'A-ONE シリーズ第 3 戦', 'am');

  r := aone_check_availability('sport', aone_today() + 10, 'kart', 'am');
  assert (r->>'reason') = 'blocked', '6-1 午前ブロックが効いていない';
  r := aone_check_availability('sport', aone_today() + 10, 'kart', 'pm');
  assert (r->>'ok')::boolean, '6-2 午後まで止まっている';
  st := aone_day_state(aone_today() + 10);
  assert (st->'sport'->'am'->'categories'->0->>'status') = 'off', '6-3 午前が off 表示にならない';

  -- カテゴリー指定ブロック
  insert into aone_blocks (date, kind, title, scope, category_code)
  values (aone_today() + 11, 'event', 'キッズイベント', 'category', 'kidskart');
  r := aone_check_availability('sport', aone_today() + 11, 'kidskart', 'am');
  assert (r->>'reason') = 'blocked', '6-4 カテゴリーブロックが効いていない';
  r := aone_check_availability('sport', aone_today() + 11, 'kart', 'am');
  assert (r->>'ok')::boolean, '6-5 別カテゴリーまで止まっている';
  -- RP には影響しない
  r := aone_check_availability('rp', aone_today() + 11, null, null, '11:00', null, 3);
  assert (r->>'ok')::boolean, '6-6 カテゴリーブロックが RP を止めている';

  -- 臨時休業 (終日)
  insert into aone_blocks (date, kind, title, scope)
  values (aone_today() + 12, 'closed', '臨時休業', 'all');
  r := aone_check_availability('rp', aone_today() + 12, null, null, '10:00', null, 5);
  assert (r->>'reason') = 'blocked', '6-7 終日ブロックが RP を止めていない';

  -- =========================================================================
  raise notice '--- 7. 走行中止';
  -- =========================================================================
  insert into aone_business_days (date, business_status, status_message)
  values (d_sunday, 'cancelled', '雨天のため本日は中止です');
  r := aone_check_availability('sport', d_sunday, 'kart', 'am');
  assert (r->>'reason') = 'weather_cancelled', '7-1 走行中止が効いていない';
  st := aone_day_state(d_sunday);
  assert (st->'business'->>'status') = 'cancelled', '7-2 day_state に営業状況が出ない';
  assert (st->'sport'->'am'->'categories'->0->>'status') = 'off', '7-3 中止日が off 表示にならない';

  -- =========================================================================
  raise notice '--- 8. 変更: 自分自身を除外して再判定';
  -- =========================================================================
  -- 貸切 B (単独日) の時間変更 → 自分自身とぶつからない
  r := aone_update_reservation(jsonb_build_object('id', id1,
        'start_time','13:00','end_time','16:00','actor','test'));
  assert (r->>'ok')::boolean, '8-1 自分自身との衝突で変更できない: ' || r::text;
  assert (r->>'start_time') = '13:00', '8-2 開始時刻が変わっていない';

  -- RP の人数変更
  r := aone_update_reservation(jsonb_build_object(
        'access_token', (select access_token::text from aone_reservations where contact_name = 'RP-A'),
        'party_size', 8, 'actor','customer'));
  assert (r->>'party_size') = '8', '8-3 人数変更が反映されない';

  -- =========================================================================
  raise notice '--- 9. キャンセルすると枠が戻る / 無断キャンセル記録';
  -- =========================================================================
  -- 日曜午後のカートをキャンセル → ミニバイクが入れるようになる
  r := aone_cancel_reservation(jsonb_build_object(
        'id', (select id from aone_reservations where contact_name = '日曜カート'),
        'reason','テスト','actor','admin'));
  assert (r->>'status') = 'cancelled', '9-1 キャンセルできない';
  r := aone_check_availability('sport', d_sunday, 'minibike', 'pm');
  -- 日曜は走行中止を入れてあるので weather_cancelled になる。営業状況を戻して再判定
  update aone_business_days set business_status = 'open' where date = d_sunday;
  r := aone_check_availability('sport', d_sunday, 'minibike', 'pm');
  assert (r->>'ok')::boolean, '9-2 キャンセル後も枠が空かない: ' || r::text;

  -- 無断キャンセル (仕様 9)
  r := aone_cancel_reservation(jsonb_build_object(
        'id', (select id from aone_reservations where contact_name = 'カートB'),
        'no_show', true, 'actor','admin'));
  assert (r->>'status') = 'no_show', '9-3 無断キャンセルが記録できない';
  assert (select no_show_count from aone_customer_stats
           where id = (select customer_id from aone_reservations where contact_name = 'カートB')) = 1,
    '9-4 顧客統計に無断キャンセルが反映されない';

  -- キャンセル規定 (2026-08 改定): 連絡があればキャンセル料なし
  -- (当日の RP は受付制限があるので、判定そのものを見るため翌日以降で作る)
  r := t_book(jsonb_build_object('kind','rp','date', aone_today()+3, 'start_time','16:00',
                                 'party_size',3,'who','RP当日'));
  r := aone_cancel_reservation(jsonb_build_object('id', (r->>'id')::uuid, 'actor','customer'));
  assert not (r->>'cancel_fee')::boolean, '9-5 連絡ありの当日キャンセルで料金フラグが立ってしまう';

  -- 当日・連絡なし (無断キャンセル) だけ料金 100%
  r := t_book(jsonb_build_object('kind','rp','date', aone_today()+3, 'start_time','16:30',
                                 'party_size',3,'who','RP無断'));
  r := aone_cancel_reservation(jsonb_build_object('id', (r->>'id')::uuid,
                                                 'no_show', true, 'actor','admin'));
  assert (r->>'cancel_fee')::boolean, '9-6 無断キャンセルの料金フラグが立たない';
  assert (r->>'status') = 'no_show', '9-7 無断キャンセルが no_show にならない';

  -- =========================================================================
  raise notice '--- 10. 管理者の強制受付 (仕様 15)';
  -- =========================================================================
  r := t_book(jsonb_build_object('kind','sport','date',d_weekday,'session','am',
                                 'category_code','other','party_size',1,
                                 'forced', true, 'forced_reason','常連さんの飛び込み',
                                 'source','phone','created_by','staff','who','強制受付'));
  assert (r->>'status') = 'confirmed', '10-1 強制受付ができない: ' || r::text;
  assert (select forced from aone_reservations where id = (r->>'id')::uuid), '10-2 forced が記録されない';
  assert (select count(*) from aone_reservation_events
           where reservation_id = (r->>'id')::uuid and event = 'forced') = 1,
    '10-3 強制受付が監査ログに残らない';

  -- =========================================================================
  raise notice '--- 11. 顧客の名寄せ (仕様 16)';
  -- =========================================================================
  -- 同じメールアドレスの 2 予約は 1 顧客にまとまる
  perform t_book(jsonb_build_object('kind','sport','date', aone_today()+9, 'session','am',
                                    'category_code','kart','party_size',1,
                                    'who','名寄せ太郎','email','yorise@example.com',
                                    'phone','090-1111-2222'));
  perform t_book(jsonb_build_object('kind','rp','date', aone_today()+9, 'start_time','15:00',
                                    'party_size',4,'who','名寄せ太郎','email','YORISE@example.com',
                                    'phone','090-1111-2222'));
  assert (select count(*) from aone_customers where lower(email) = 'yorise@example.com') = 1,
    '11-1 メールで名寄せされていない';
  assert (select sport_count + rp_count from aone_customer_stats
           where lower(email) = 'yorise@example.com') = 2,
    '11-2 顧客統計が合算されない';


  -- =========================================================================
  raise notice '--- 12. 電話予約も同じ台帳に入り、即座に Web の空きへ反映される (仕様 13)';
  -- =========================================================================
  -- 別の平日の午後枠を電話予約 2 件で埋める
  perform t_book(jsonb_build_object('kind','sport','date', d_wd2, 'session','pm',
                                    'category_code','kart','party_size',1,'source','phone',
                                    'who','電話予約A','phone','092-000-0001'));
  perform t_book(jsonb_build_object('kind','sport','date', d_wd2, 'session','pm',
                                    'category_code','minibike','party_size',1,'source','counter',
                                    'who','店頭予約B','phone','092-000-0002'));
  st := aone_day_state(d_wd2);
  assert (st->'sport'->'pm'->>'used_classes') = '2',
    '12-1 電話・店頭予約がクラス数に反映されない';
  r := aone_check_availability('sport', d_wd2, 'kidskart', 'pm');
  assert (r->>'reason') = 'class_full',
    '12-2 電話予約が Web の空きを塞いでいない: ' || r::text;

  -- =========================================================================
  raise notice '--- 13. 連絡待ちの貸切は他予約を止めない (確定してから止める)';
  -- =========================================================================
  -- +7 日にスポーツ走行 → その後に貸切申込 (連絡待ちになる)
  perform t_book(jsonb_build_object('kind','sport','date', aone_today()+7, 'session','am',
                                    'category_code','kart','party_size',1,'who','先客'));
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+7, 'start_time','09:00',
                                 'end_time','12:00','party_size',10,'who','貸切C'));
  assert (r->>'status') = 'contact_wait', '13-1 貸切が連絡待ちにならない';
  id1 := (r->>'id')::uuid;
  -- 連絡待ちの間は RP もスポーツも受け付けられる
  r := aone_check_availability('rp', aone_today()+7, null, null, '10:00', null, 4);
  assert (r->>'ok')::boolean, '13-2 連絡待ちの貸切が RP を止めている: ' || r::text;
  -- 管理者が確定させると止まる
  perform aone_set_reservation_status(jsonb_build_object('id', id1, 'status','confirmed','actor','admin'));
  r := aone_check_availability('rp', aone_today()+7, null, null, '10:00', null, 4);
  assert (r->>'reason') = 'charter_confirmed', '13-3 確定貸切が RP を止めていない';

  -- =========================================================================
  raise notice '--- 14. 料金の自動計算 (2026-08 改定)';
  -- =========================================================================
  -- RP = 6,600 円 x 人数
  r := t_book(jsonb_build_object('kind','rp','date', aone_today()+21, 'start_time','10:00',
                                 'party_size',3,'who','料金RP'));
  assert (select amount from aone_reservations where id = (r->>'id')::uuid) = 19800,
    '14-1 RP の金額が 6,600 x 3 にならない';

  -- 貸切 = 11,000 + 11,000 x 台数 (最小 5 台) → 台数未指定なら 66,000 円
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+22, 'start_time','09:00',
                                 'end_time','12:00','party_size',10,'who','料金貸切'));
  assert (select amount from aone_reservations where id = (r->>'id')::uuid) = 66000,
    '14-2 貸切の金額が 11,000 + 11,000 x 5 にならない: '
      || (select amount from aone_reservations where id = (r->>'id')::uuid)::text;

  -- 台数を指定した貸切 (8 台) → 11,000 + 11,000 x 8 = 99,000 円
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+23, 'start_time','09:00',
                                 'end_time','12:00','party_size',16,'vehicle_count',8,'who','料金貸切8'));
  assert (select amount from aone_reservations where id = (r->>'id')::uuid) = 99000,
    '14-3 台数指定の貸切の金額が合わない';

  -- =========================================================================
  raise notice '--- 15. 折り返し対応の記録と放置の検知';
  -- =========================================================================
  perform t_book(jsonb_build_object('kind','sport','date', aone_today()+25, 'session','am',
                                    'category_code','kart','party_size',1,'who','先客15'));
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+25, 'start_time','09:00',
                                 'end_time','12:00','party_size',8,'who','折り返し待ち'));
  assert (r->>'status') = 'contact_wait', '15-1 貸切が連絡待ちにならない';
  id1 := (r->>'id')::uuid;

  assert exists (select 1 from aone_pending_callbacks(0) p where p.id = id1),
    '15-2 未対応の連絡待ちが放置リストに出ない';

  -- 対応済みにすると消える
  perform aone_mark_contacted(jsonb_build_object('id', id1, 'method','phone',
                                                 'result','留守電','actor','staff'));
  assert not exists (select 1 from aone_pending_callbacks(0) p where p.id = id1),
    '15-3 対応済みなのに放置リストに残っている';
  assert (select contact_method from aone_reservations where id = id1) = 'phone',
    '15-4 対応手段が記録されない';
  assert (select count(*) from aone_reservation_events
           where reservation_id = id1 and event = 'contacted') = 1,
    '15-5 対応が監査ログに残らない';

  -- 取り消すと戻る
  perform aone_mark_contacted(jsonb_build_object('id', id1, 'undo', true, 'actor','staff'));
  assert exists (select 1 from aone_pending_callbacks(0) p where p.id = id1),
    '15-6 対応記録を取り消しても放置リストに戻らない';

  -- 24 時間しきい値: 作ったばかりのものは出ない
  assert not exists (select 1 from aone_pending_callbacks(24) p where p.id = id1),
    '15-7 受付直後なのに 24 時間の放置リストに出てしまう';

  -- 確定させれば対象外
  perform aone_set_reservation_status(jsonb_build_object('id', id1, 'status','confirmed','actor','admin'));
  assert not exists (select 1 from aone_pending_callbacks(0) p where p.id = id1),
    '15-8 確定済みが放置リストに残っている';

  -- =========================================================================
  raise notice '--- 16. 人数・台数を変えたら金額も追従する';
  -- =========================================================================
  -- RP 3 名 (19,800 円) → 5 名 (33,000 円)
  r := t_book(jsonb_build_object('kind','rp','date', aone_today()+26, 'start_time','10:00',
                                 'party_size',3,'who','金額追従RP'));
  id1 := (r->>'id')::uuid;
  assert (select amount from aone_reservations where id = id1) = 19800, '16-1 初期金額が違う';
  perform aone_update_reservation(jsonb_build_object('id', id1, 'party_size', 5,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 33000,
    '16-2 人数変更で金額が追従しない: '
      || (select amount from aone_reservations where id = id1)::text;

  -- 手入力で値引きした金額は上書きしない
  update aone_reservations set amount = 30000 where id = id1;
  assert (select amount_manual from aone_reservations where id = id1),
    '16-3a 金額を書き換えても手入力フラグが立たない';
  perform aone_update_reservation(jsonb_build_object('id', id1, 'party_size', 6,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 30000,
    '16-3 手入力の金額が上書きされてしまう';

  -- ズレたまま残っている行 (手入力フラグは立っていない) を再現し、
  -- 次の変更で自動計算に戻ることを確かめる。
  -- 12,345 円は自動計算と違う額なので、通常の UPDATE では手入力扱いになる。
  -- 「0016 以前からズレていた」状況を作るためトリガーを外して用意する
  alter table aone_reservations disable trigger aone_res_recalc_amount;
  update aone_reservations set amount = 12345, amount_manual = false where id = id1;
  alter table aone_reservations enable trigger aone_res_recalc_amount;

  perform aone_update_reservation(jsonb_build_object('id', id1, 'party_size', 7,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 46200,
    '16-3b ズレていた金額が自動計算に戻らない: '
      || (select amount from aone_reservations where id = id1)::text;

  -- 自動計算と同じ額を入れ直しても手入力扱いにしない
  -- (0017 の一括修正がトリガーを踏んで、直した行を全部手入力にしてしまった)
  update aone_reservations set amount = 46200 where id = id1;
  assert not (select amount_manual from aone_reservations where id = id1),
    '16-3c 自動計算と同じ額を入れただけで手入力扱いになる';
  perform aone_update_reservation(jsonb_build_object('id', id1, 'party_size', 8,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 52800,
    '16-3d 一度自動計算に揃えたあと追従しなくなる';

  -- 貸切 5 台 (66,000 円) → 8 台 (99,000 円)
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+27, 'start_time','09:00',
                                 'end_time','12:00','party_size',10,'who','金額追従貸切'));
  id1 := (r->>'id')::uuid;
  assert (select amount from aone_reservations where id = id1) = 66000, '16-4 貸切の初期金額が違う';
  perform aone_update_reservation(jsonb_build_object('id', id1, 'vehicle_count', 8,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 99000,
    '16-5 台数変更で金額が追従しない';

  -- 会計済みは触らない
  update aone_reservations set is_paid = true where id = id1;
  perform aone_update_reservation(jsonb_build_object('id', id1, 'vehicle_count', 10,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 99000,
    '16-6 会計済みの金額が変わってしまう';

  -- =========================================================================
  raise notice '--- 17. 貸切と当日 RP の受付制限';
  -- =========================================================================
  -- 貸切: 4 台以下は受け付けない
  r := aone_check_availability('charter', aone_today()+30, null, null, '09:00', '12:00', 8, null, 4);
  assert not (r->>'ok')::boolean and (r->>'reason') = 'charter_min_karts',
    '17-1 貸切 4 台が受け付けられてしまう: ' || r::text;
  r := aone_check_availability('charter', aone_today()+30, null, null, '09:00', '12:00', 8, null, 5);
  assert (r->>'ok')::boolean, '17-2 貸切 5 台が受け付けられない: ' || r::text;

  -- 台数の指定が無い申込も受けない (最小台数を満たすか判断できないため通す)
  r := aone_check_availability('charter', aone_today()+30, null, null, '09:00', '12:00', 8);
  assert (r->>'ok')::boolean, '17-3 台数未指定の貸切が弾かれる';

  -- 貸切: 当日は受け付けない
  r := aone_check_availability('charter', aone_today(), null, null, '09:00', '12:00', 8, null, 5);
  assert not (r->>'ok')::boolean and (r->>'reason') = 'charter_lead_time',
    '17-4 当日の貸切が受け付けられてしまう: ' || r::text;
  r := aone_check_availability('charter', aone_today()+1, null, null, '09:00', '12:00', 8, null, 5);
  assert (r->>'ok')::boolean, '17-5 翌日の貸切が受け付けられない: ' || r::text;

  -- 予約 RPC からも同じ判定になる (台数が渡っているか)
  begin
    perform t_book(jsonb_build_object('kind','charter','date', aone_today()+31,
                                      'start_time','09:00','end_time','12:00',
                                      'party_size',8,'vehicle_count',4,'who','貸切4台'));
    assert false, '17-6 貸切 4 台が RPC 経由で登録できてしまう';
  exception when sqlstate 'AONE1' then null;
  end;

  -- 当日の RP: 17:00 以降は受け付けない
  r := aone_check_availability('rp', aone_today(), null, null, '17:00', null, 3);
  assert not (r->>'ok')::boolean and (r->>'reason') = 'rp_same_day_late',
    '17-7 当日 17:00 の RP が受け付けられてしまう: ' || r::text;

  -- 当日の RP: 2 時間後以降のみ (10 分後は不可)
  r := aone_check_availability('rp', aone_today(), null, null,
                               ((now() at time zone 'Asia/Tokyo')::time + interval '10 min')::time,
                               null, 3);
  assert not (r->>'ok')::boolean,
    '17-8 直近の当日 RP が受け付けられてしまう: ' || r::text;

  -- 翌日以降は 17:00 も 2 時間ルールも関係ない
  r := aone_check_availability('rp', aone_today()+2, null, null, '17:00', null, 3);
  assert (r->>'ok')::boolean, '17-9 翌日以降の 17:00 の RP が受け付けられない: ' || r::text;

  -- =========================================================================
  raise notice '--- 18. コース貸切のみ (要見積り)';
  -- =========================================================================
  -- 台数が無くても受け付ける。ただし必ず確認中 (折り返し) になる
  r := aone_check_availability('charter', aone_today()+32, null, null, '09:00', '12:00',
                               8, null, null, 'course_only');
  assert (r->>'ok')::boolean and (r->>'status') = 'checking',
    '18-1 コースのみの貸切が確認中にならない: ' || r::text;

  -- 他の予約があっても、連絡待ちではなく確認中のまま (必ず折り返す)
  perform t_book(jsonb_build_object('kind','sport','date', aone_today()+33, 'session','am',
                                    'category_code','kart','party_size',1,'who','先客18'));
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+33,
                                 'start_time','09:00','end_time','12:00','party_size',20,
                                 'charter_type','course_only','who','コース貸切'));
  assert (r->>'status') = 'checking', '18-2 コースのみの貸切の状態が違う: ' || r::text;
  id1 := (r->>'id')::uuid;

  -- 金額は入れない (都度見積り)
  assert (select amount from aone_reservations where id = id1) is null,
    '18-3 コースのみの貸切に金額が入ってしまう';
  assert (select charter_type from aone_reservations where id = id1) = 'course_only',
    '18-4 貸切の種別が保存されない';

  -- スタッフが金額を入れたら、以後は自動計算に触られない
  update aone_reservations set amount = 80000 where id = id1;
  assert (select amount_manual from aone_reservations where id = id1),
    '18-5 見積り金額が手入力として記録されない';
  perform aone_update_reservation(jsonb_build_object('id', id1, 'party_size', 30,
                                                     'forced', true, 'actor','admin'));
  assert (select amount from aone_reservations where id = id1) = 80000,
    '18-6 見積り金額が上書きされてしまう';

  -- レンタルカート付きは従来どおり自動計算
  r := t_book(jsonb_build_object('kind','charter','date', aone_today()+34,
                                 'start_time','09:00','end_time','12:00','party_size',10,
                                 'vehicle_count',6,'charter_type','with_karts','who','カート付き'));
  assert (select amount from aone_reservations where id = (r->>'id')::uuid) = 77000,
    '18-7 レンタルカート付きの金額が違う';

  -- 台数不足はコースのみでも当日不可は効く
  r := aone_check_availability('charter', aone_today(), null, null, '09:00', '12:00',
                               8, null, null, 'course_only');
  assert not (r->>'ok')::boolean and (r->>'reason') = 'charter_lead_time',
    '18-8 当日のコース貸切が受け付けられてしまう';

  -- =========================================================================
  raise notice '--- 19. 営業状況と路面状況';
  -- =========================================================================
  -- 既定は「営業中」。何も設定していない日は open で返る
  st := aone_day_state(aone_today() + 40);
  assert (st->'business'->>'status') = 'open', '19-1 既定が営業中になっていない';
  assert (st->'business'->>'source') = 'manual', '19-2 既定の出どころが manual でない';
  assert (st->'surface'->>'status') is null, '19-3 路面が未設定にならない';

  -- 休業にすると受け付けない
  insert into aone_business_days (date, business_status) values (aone_today() + 40, 'closed');
  r := aone_check_availability('sport', aone_today() + 40, 'kart', 'am');
  assert (r->>'reason') = 'business_closed', '19-4 休業日が受け付けられてしまう';
  st := aone_day_state(aone_today() + 40);
  assert (st->'business'->>'status') = 'closed', '19-5 day_state が休業にならない';
  assert (st->'sport'->'am'->'categories'->0->>'status') = 'off', '19-6 休業日が off 表示にならない';

  -- 路面状況は受付可否に一切影響しない (ヘビーウェットでも予約は取れる)
  update aone_business_days set business_status = 'open', surface_status = 'heavy_wet'
  where date = aone_today() + 40;
  r := aone_check_availability('sport', aone_today() + 40, 'kart', 'am');
  assert (r->>'ok')::boolean, '19-7 路面状況が受付を止めてしまう: ' || r::text;
  st := aone_day_state(aone_today() + 40);
  assert (st->'surface'->>'status') = 'heavy_wet', '19-8 day_state に路面が出ない';
  assert (st->'business'->>'status') = 'open', '19-9 路面を入れると営業状況が変わってしまう';

  -- 臨時休業の予定を入れておけば、営業状況は自動で休業になる (二重入力しない)
  insert into aone_blocks (date, kind, title, scope)
  values (aone_today() + 41, 'closed', 'お盆休み', 'all');
  st := aone_day_state(aone_today() + 41);
  assert (st->'business'->>'status') = 'closed', '19-10 臨時休業の予定が営業状況に出ない';
  assert (st->'business'->>'source') = 'block', '19-11 休業の出どころが block でない';

  -- 手で「走行中止」にしてある日は、予定より手の設定が勝つ
  insert into aone_business_days (date, business_status) values (aone_today() + 41, 'cancelled');
  st := aone_day_state(aone_today() + 41);
  assert (st->'business'->>'status') = 'cancelled', '19-12 手の設定が予定に上書きされる';

  -- 月ダイジェストにも 2 軸で出る
  update aone_business_days set business_status = 'open', surface_status = 'drying'
  where date = aone_today() + 40;
  assert (select x->>'surface' from jsonb_array_elements(
            aone_month_state(extract(year from aone_today() + 40)::int,
                             extract(month from aone_today() + 40)::int)) x
          where x->>'date' = to_char(aone_today() + 40, 'YYYY-MM-DD')) = 'drying',
    '19-13 月ダイジェストに路面が出ない';

  -- =========================================================================
  raise notice '--- 20. イベントの参加申込';
  -- =========================================================================
  declare
    v_ev1 uuid; v_ev2 uuid; v_ev3 uuid; v_entry jsonb;
  begin
    -- 耐久 (チーム単位) / スプリント (人単位) / シリーズ戦 (クラスあり)
    insert into aone_blocks (date, kind, title, scope, entry_open, entry_type,
                             entry_price, entry_unit, entry_rules_url)
    values (aone_today() + 60, 'event', '90分耐久', 'all', true, 'endurance',
            20000, 'team', 'https://example.com/rules.pdf')
    returning id into v_ev1;

    insert into aone_blocks (date, kind, title, scope, entry_open, entry_type,
                             entry_price, entry_unit)
    values (aone_today() + 61, 'event', 'スプリント', 'all', true, 'sprint', 7000, 'person')
    returning id into v_ev2;

    insert into aone_blocks (date, kind, title, scope, entry_open, entry_type,
                             entry_unit, entry_classes)
    values (aone_today() + 62, 'race', 'RMC エーワンシリーズ', 'all', true, 'series',
            'person', array['Light','Junior','Mini','Micro','ビギナー','SS'])
    returning id into v_ev3;

    -- 受付中の一覧に 3 件とも出る
    assert jsonb_array_length(aone_open_events()) >= 3, '20-1 受付中イベントが出ない';

    -- 耐久: チーム名 + 代表者。金額はイベントの設定がそのまま入る
    v_entry := aone_create_event_entry(jsonb_build_object(
      'block_id', v_ev1, 'team_name', 'チーム A-ONE',
      'contact', jsonb_build_object('name','今井 太郎','kana','イマイ タロウ',
                                    'email','imai@example.com','phone','09011112222'),
      'agreed', true));
    assert (v_entry->>'ok')::boolean, '20-2 耐久の申込ができない: ' || v_entry::text;
    assert (v_entry->>'amount') = '20000', '20-3 耐久の金額が違う: ' || v_entry::text;
    assert (v_entry->>'entry_number') like 'E%', '20-4 申込番号の形式が違う';
    assert (select agreed_at from aone_event_entries where id = (v_entry->>'id')::uuid) is not null,
      '20-5 同意の記録が残らない';

    -- 顧客が名寄せされる (同じ電話番号で走行予約を入れると同じ顧客になる)
    r := t_book(jsonb_build_object('kind','rp','date', aone_today()+63, 'start_time','10:00',
                                   'party_size',3,'who','今井 太郎','phone','09011112222'));
    assert (select customer_id from aone_reservations where id = (r->>'id')::uuid)
         = (select customer_id from aone_event_entries where id = (v_entry->>'id')::uuid),
      '20-6 エントリーと予約で顧客が別になる';

    -- 金額を出さないイベント (RMC) は amount が null で受け付けられる
    v_entry := aone_create_event_entry(jsonb_build_object(
      'block_id', v_ev3, 'team_name','A-ONE レーシング', 'race_class','Junior',
      'frame_maker','トニーカート', 'number_wish','7',
      'contact', jsonb_build_object('name','山田 花子','email','y@example.com','phone','09033334444'),
      'agreed', true));
    assert (v_entry->>'ok')::boolean, '20-7 シリーズ戦の申込ができない: ' || v_entry::text;
    assert (v_entry->'amount') = 'null'::jsonb, '20-8 金額なしのはずが入っている: ' || v_entry::text;
    assert (select race_class from aone_event_entries where id = (v_entry->>'id')::uuid) = 'Junior',
      '20-9 参加クラスが保存されない';

    -- クラスの選択肢があるのに選んでいないと断る
    begin
      perform aone_create_event_entry(jsonb_build_object(
        'block_id', v_ev3, 'team_name','T',
        'contact', jsonb_build_object('name','A','email','a@example.com','phone','090')));
      raise exception '20-10 参加クラス未選択が通ってしまった';
    exception when sqlstate 'AONE1' then null;
    end;

    -- チーム名は 3 種別とも必須
    begin
      perform aone_create_event_entry(jsonb_build_object(
        'block_id', v_ev2,
        'contact', jsonb_build_object('name','A','email','a@example.com','phone','090')));
      raise exception '20-11 チーム名なしが通ってしまった';
    exception when sqlstate 'AONE1' then null;
    end;

    -- メールは必須 (連絡が取れないと参加案内を送れない)
    begin
      perform aone_create_event_entry(jsonb_build_object(
        'block_id', v_ev2, 'team_name','T',
        'contact', jsonb_build_object('name','A','phone','090')));
      raise exception '20-12 メールなしが通ってしまった';
    exception when sqlstate 'AONE1' then null;
    end;

    -- 受付を止めたイベントには申し込めない
    update aone_blocks set entry_open = false where id = v_ev2;
    begin
      perform aone_create_event_entry(jsonb_build_object(
        'block_id', v_ev2, 'team_name','T',
        'contact', jsonb_build_object('name','A','email','a@example.com','phone','090')));
      raise exception '20-13 受付停止中のイベントに申し込めてしまった';
    exception when sqlstate 'AONE1' then null;
    end;
    assert (select count(*) from jsonb_array_elements(aone_open_events()) x
             where (x->>'id')::uuid = v_ev2) = 0, '20-14 受付停止が一覧から消えない';

    -- 締切を過ぎたら断る。ただし管理者の代理入力 (forced) は通す
    update aone_blocks set entry_open = true, entry_deadline = aone_today() - 1 where id = v_ev2;
    begin
      perform aone_create_event_entry(jsonb_build_object(
        'block_id', v_ev2, 'team_name','T',
        'contact', jsonb_build_object('name','A','email','a@example.com','phone','090')));
      raise exception '20-15 締切後に申し込めてしまった';
    exception when sqlstate 'AONE1' then null;
    end;
    v_entry := aone_create_event_entry(jsonb_build_object(
      'block_id', v_ev2, 'team_name','T', 'forced', true, 'source','phone',
      'contact', jsonb_build_object('name','A','email','a@example.com','phone','090')));
    assert (v_entry->>'ok')::boolean, '20-16 締切後の代理入力ができない';

    -- 取り消しても記録は残る
    v_entry := aone_cancel_event_entry(jsonb_build_object('id', v_entry->>'id', 'reason','都合により'));
    assert (v_entry->>'status') = 'cancelled', '20-17 申込を取り消せない';

    -- イベント (予定) を消しても申込の記録は残る
    delete from aone_blocks where id = v_ev1;
    assert (select count(*) from aone_event_entries where event_title = '90分耐久') = 1,
      '20-18 予定を消すと申込まで消える';
    assert (select block_id from aone_event_entries where event_title = '90分耐久') is null,
      '20-19 消えた予定への参照が残っている';
  end;

  -- =========================================================================
  raise notice '--- 21. 公開表示の「姓のみ」';
  -- =========================================================================
  -- 法人名・カタカナ姓を機械的に 2 文字で切ると意味が通らなくなる (実運用で発覚)
  assert aone_public_name('(株)ふーぷーパートナーズ', 'family') = '(株)ふーぷーパートナーズ 様',
    '21-1 法人名が略されてしまう: ' || aone_public_name('(株)ふーぷーパートナーズ', 'family');
  assert aone_public_name('A-ONE Racing', 'family') = 'A-ONE Racing 様',
    '21-2 英字の団体名が空白で切られる: ' || aone_public_name('A-ONE Racing', 'family');
  assert aone_public_name('麻生工科大学', 'family') = '麻生工科大学 様', '21-3 大学名が略される';
  assert aone_public_name('エンドウ', 'family') = 'エンドウ 様', '21-4 カタカナ姓が切られる';
  assert aone_public_name('ナカゾノ', 'family') = 'ナカゾノ 様', '21-5 カタカナ姓が切られる';

  -- 個人名の姓のみは今までどおり
  assert aone_public_name('山田 太郎', 'family') = '山田 様', '21-6 空白区切りの姓が出ない';
  assert aone_public_name('長谷川 一郎', 'family') = '長谷川 様', '21-7 3 文字の姓が切れる';
  assert aone_public_name('山田太郎', 'family') = '山田 様', '21-8 続けて書いた姓名が略されない';
  assert aone_public_name('今井', 'family') = '今井 様', '21-9 短い姓が変わる';

  -- full / hidden は変えていない
  assert aone_public_name('山田 太郎', 'full') = '山田 太郎 様', '21-10 full が変わった';
  assert aone_public_name('山田 太郎', 'hidden') is null, '21-11 hidden が変わった';
  -- 「様」が入っていても二重にならない
  assert aone_public_name('山田 太郎様', 'full') = '山田 太郎 様', '21-12 敬称が二重になる';

  -- =========================================================================
  raise notice '--- 22. 「このカテゴリーだけ走れる」予定 (レース前日)';
  -- =========================================================================
  declare d_only date := aone_today() + 90;
  begin
    -- カートだけ許して、ほかのスポーツ走行は止める
    insert into aone_blocks (date, kind, title, scope, allow_categories)
    values (d_only, 'event', 'レース前日', 'only_category', array['kart']);

    r := aone_check_availability('sport', d_only, 'kart', 'am');
    assert (r->>'ok')::boolean, '22-1 許可したカートが止まってしまう: ' || r::text;
    r := aone_check_availability('sport', d_only, 'minibike', 'am');
    assert (r->>'reason') = 'blocked', '22-2 ミニバイクが止まらない: ' || r::text;
    r := aone_check_availability('sport', d_only, 'kidskart', 'pm');
    assert (r->>'reason') = 'blocked', '22-3 キッズカートが止まらない';

    -- スポーツ走行だけの指定。RP・貸切には効かない (止めたいなら別の予定を足す)
    r := aone_check_availability('rp', d_only, null, null, '10:00', null, 5);
    assert (r->>'ok')::boolean, '22-4 RP まで止まってしまう: ' || r::text;

    -- day_state の表示も合っているか (カートは受付可、ミニバイクは off)
    st := aone_day_state(d_only);
    assert (select x->>'status' from jsonb_array_elements(st->'sport'->'am'->'categories') x
             where x->>'code' = 'kart') <> 'off', '22-5 カートが off 表示になる';
    assert (select x->>'status' from jsonb_array_elements(st->'sport'->'am'->'categories') x
             where x->>'code' = 'minibike') = 'off', '22-6 ミニバイクが off 表示にならない';

    -- 2 つ許すこともできる
    update aone_blocks set allow_categories = array['kart','minibike'] where date = d_only;
    r := aone_check_availability('sport', d_only, 'minibike', 'am');
    assert (r->>'ok')::boolean, '22-7 許可を足してもミニバイクが止まったまま';

    -- 許可が空なら何も止めない (登録し忘れで全部止まる事故を避ける)
    update aone_blocks set allow_categories = '{}' where date = d_only;
    r := aone_check_availability('sport', d_only, 'minibike', 'am');
    assert (r->>'ok')::boolean, '22-8 許可が空のときに止まってしまう';

    -- ★ すでに入っている予約は、あとから予定を足しても消えない
    update aone_blocks set allow_categories = array['kart'] where date = d_only;
    r := t_book(jsonb_build_object('kind','sport','date', d_only, 'session','am',
                                   'category_code','minibike','party_size',1,
                                   'forced', true, 'who','先に入っていたミニバイク'));
    assert (r->>'ok')::boolean, '22-9 強制受付ができない';
    assert (select count(*) from aone_reservations
             where date = d_only and category_code = 'minibike' and aone_is_live(status)) = 1,
      '22-10 予定を足すと既存の予約が消える';
  end;

  raise notice 'ALL TESTS PASSED';
end;
$$;

rollback;
