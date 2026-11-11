import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './d1-adapter.ts';
import { calcPrice } from '../src/lib/shop/pricing.ts';
import { createPendingOrder, finalizePayment, refundPayment, canDownload, photosToPurge,
         expirePendingOrders, approveReviewedOrder } from '../src/lib/shop/orders.ts';
import { ShopError } from '../src/lib/shop/db.ts';

const NOW = new Date('2026-11-11T05:00:00Z');     // JST 14:00
const P = { single: 500, set3: 1000, pack: 2000 };

function seed() {
  const t = openTestDb();
  const g = (id: string, token: string, name: string, extra = '') => t.raw.exec(
    `INSERT INTO groups(id, qr_token, shoot_date, name, headcount, consent_shoot, consent_online, consent_tv, status ${extra ? ',' + extra.split('|')[0] : ''})
     VALUES ('${id}', '${token}', '2026-11-11', '${name}', 5, 1, 1, 0, 'published' ${extra ? ',' + extra.split('|')[1] : ''})`);
  g('ga', 'TOKA', 'A団体');
  g('gb', 'TOKB', 'B団体');
  for (let i = 1; i <= 10; i++) t.raw.exec(
    `INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key, taken_at)
     VALUES ('p${i}', 'ga', 's${i}', 'o/${i}', 'p/${i}', 't/${i}', '2026-11-11T04:${String(i).padStart(2, '0')}:00Z')`);
  t.raw.exec(`INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key)
              VALUES ('px', 'gb', 'sx', 'o/x', 'p/x', 't/x')`);
  return t;
}
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e instanceof ShopError && e.code === code);
const q = (t: ReturnType<typeof seed>, sql: string) => t.raw.prepare(sql).get() as any;

test('価格: 500 / 1000 / 2000 と自動パック切替', () => {
  const c = (n: number) => calcPrice(n, P);
  assert.deepEqual([1, 2, 3, 4].map((n) => c(n).amount), [500, 1000, 1000, 1500]);
  assert.deepEqual(c(5), { amount: 2000, pack: true });
  assert.deepEqual(c(40), { amount: 2000, pack: true });
  assert.throws(() => c(0));
  assert.equal(calcPrice(3, { single: 600, set3: 1200, pack: 2500 }).amount, 1200);   // 設定で変わる
});

test('同意: 未成年は保護者同意が必要 / TV は別管理 / 同意なしは公開不可', () => {
  const t = openTestDb();
  t.raw.exec(`INSERT INTO groups(id, shoot_date) VALUES ('g1', '2026-11-11')`);
  assert.throws(() => t.raw.exec(`UPDATE groups SET status='published' WHERE id='g1'`), /CHECK/);
  t.raw.exec(`UPDATE groups SET consent_shoot=1, consent_online=1, consent_tv=1, has_minor=1 WHERE id='g1'`);
  assert.deepEqual([q(t, `SELECT online_ok a, tv_ok b FROM groups`).a, q(t, `SELECT tv_ok b FROM groups`).b], [0, 0]);
  assert.throws(() => t.raw.exec(`UPDATE groups SET status='published' WHERE id='g1'`), /CHECK/);
  t.raw.exec(`UPDATE groups SET guardian_consent=1 WHERE id='g1'`);
  assert.equal(q(t, `SELECT online_ok a FROM groups`).a, 1);
  t.raw.exec(`UPDATE groups SET consent_tv=0 WHERE id='g1'`);
  assert.deepEqual([q(t, `SELECT online_ok a FROM groups`).a, q(t, `SELECT tv_ok b FROM groups`).b], [1, 0]);
});

test('注文: 検証・他グループ拒否・未公開拒否', async () => {
  const t = seed();
  await rejects(createPendingOrder(t.db, { qrToken: 'NOPE', photoIds: ['p1'], email: 'a@x.jp' }, NOW), 'group_not_available');
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: '' }, NOW), 'email_required');
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['px'], email: 'a@x.jp' }, NOW), 'photo_not_available');
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: [], email: 'a@x.jp' }, NOW), 'empty_selection');
  t.raw.exec(`UPDATE groups SET status='hidden' WHERE id='ga'`);
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW), 'group_not_available');
  t.raw.exec(`UPDATE groups SET status='published' WHERE id='ga'`);
  // 閲覧期間 (30 日) を過ぎたら買えない
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, new Date('2026-12-12T05:00:00Z')), 'group_not_available');
});

test('同じ写真を A・B・C が別々に購入できる / 権限・返金は独立', async () => {
  const t = seed();
  const mk = (email: string, ids: string[]) => createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ids, email }, NOW);
  const a = await mk('a@x.jp', ['p1', 'p2', 'p3']);
  const b = await mk('b@x.jp', ['p1', 'p2', 'p3']);          // 同じ 3 枚
  const c = await mk('c@x.jp', ['p3']);
  assert.deepEqual([a.amountJpy, b.amountJpy, c.amountJpy], [1000, 1000, 500]);
  assert.notEqual(a.orderToken, b.orderToken);
  for (const [o, pi] of [[a, 'pi_a'], [b, 'pi_b'], [c, 'pi_c']] as const) {
    assert.equal((await finalizePayment(t.db, { orderId: o.orderId, paymentIntent: pi, amountJpy: o.amountJpy }, NOW)).outcome, 'paid');
  }
  for (const o of [a, b, c]) assert.ok((await canDownload(t.db, o.orderToken, 'p3', NOW)).ok);
  assert.ok(!(await canDownload(t.db, c.orderToken, 'p1', NOW)).ok);       // C は p1 を買っていない
  assert.ok(!(await canDownload(t.db, a.orderToken, 'p4', NOW)).ok);

  // B だけ返金 → B は不可、A と C は変わらず
  const payB = q(t, `SELECT id FROM payments WHERE stripe_payment_intent='pi_b'`).id;
  await refundPayment(t.db, { paymentId: payB, stripeRefundId: 're_b', reason: 'test' }, NOW);
  assert.ok(!(await canDownload(t.db, b.orderToken, 'p1', NOW)).ok);
  assert.ok((await canDownload(t.db, a.orderToken, 'p1', NOW)).ok);
  assert.ok((await canDownload(t.db, c.orderToken, 'p3', NOW)).ok);
  await refundPayment(t.db, { paymentId: payB }, NOW);                      // 再実行しても安全
  assert.equal(q(t, `SELECT count(*) n FROM refunds`).n, 1);
});

test('同じ購入者が自分の購入済み写真を単品で再購入しようとすると止める', async () => {
  const t = seed();
  const a = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'A@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: a.orderId, paymentIntent: 'pi_1', amountJpy: 500 }, NOW);
  await rejects(createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1', 'p2'], email: 'a@x.jp' }, NOW), 'already_owned');
  // 別のお客様は買える
  assert.ok(await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'z@x.jp' }, NOW));
});

test('全写真パック: 他のお客様が購入済みの写真も含め、公開写真すべて (10 枚) を 2000 円で', async () => {
  const t = seed();
  const a = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1', 'p2', 'p3'], email: 'a@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: a.orderId, paymentIntent: 'pi_a', amountJpy: 1000 }, NOW);
  t.raw.exec(`UPDATE photos SET status='hidden' WHERE id='p10'`);            // 非公開の写真は含めない
  const pk = await createPendingOrder(t.db, { qrToken: 'TOKA', pack: true, email: 'b@x.jp' }, NOW);
  assert.deepEqual([pk.amountJpy, pk.photoCount, pk.packApplied], [2000, 9, true]);
  // 5 枚以上を選ぶと自動でパックになる
  const five = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1', 'p2', 'p3', 'p4', 'p5'], email: 'c@x.jp' }, NOW);
  assert.deepEqual([five.amountJpy, five.photoCount, five.packApplied], [2000, 9, true]);
  await finalizePayment(t.db, { orderId: pk.orderId, paymentIntent: 'pi_b', amountJpy: 2000 }, NOW);
  assert.ok((await canDownload(t.db, pk.orderToken, 'p1', NOW)).ok);         // A が買った写真も B のパックに入る
  assert.ok(!(await canDownload(t.db, pk.orderToken, 'p10', NOW)).ok);
  // 写真が 2 枚しか無い団体でパックを選んでも 1,000 円 (2000 円にはならない)
  t.raw.exec(`INSERT INTO photos(id, group_id, sha256, original_key, preview_key, thumb_key) VALUES ('y1','gb','sy1','o','p','t')`);
  const small = await createPendingOrder(t.db, { qrToken: 'TOKB', pack: true, email: 'd@x.jp' }, NOW);
  assert.deepEqual([small.amountJpy, small.photoCount, small.packApplied], [1000, 2, false]);
});

test('同一注文の二重決済防止: 連打・Webhook 再送・同時・2 回目の支払い', async () => {
  const t = seed();
  // 連打・再読込: 同じ内容の未決済注文は作り直さず再利用
  const o1 = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1', 'p2'], email: 'a@x.jp' }, NOW);
  const o2 = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p2', 'p1'], email: 'A@X.jp' }, NOW);
  assert.equal(o2.orderId, o1.orderId); assert.ok(o2.reused);
  assert.equal(q(t, `SELECT count(*) n FROM orders`).n, 1);
  // 内容が違えば別注文
  const o3 = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW);
  assert.notEqual(o3.orderId, o1.orderId);

  // Webhook 再送 (同じ payment_intent) は何も増やさない
  const f = { orderId: o1.orderId, paymentIntent: 'pi_1', amountJpy: 1000 };
  assert.equal((await finalizePayment(t.db, f, NOW)).outcome, 'paid');
  assert.equal((await finalizePayment(t.db, f, NOW)).outcome, 'replayed');
  // 同時に 2 本届いても 1 回だけ paid
  const o4 = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p5'], email: 'e@x.jp' }, NOW);
  const rs = await Promise.all([
    finalizePayment(t.db, { orderId: o4.orderId, paymentIntent: 'pi_x', amountJpy: 500 }, NOW),
    finalizePayment(t.db, { orderId: o4.orderId, paymentIntent: 'pi_y', amountJpy: 500 }, NOW)]);
  assert.deepEqual(rs.map((r) => r.outcome).sort(), ['duplicate_payment', 'paid']);

  // 決済済み注文への 2 本目の支払い: 写真は増えず、要確認に出る
  const dup = await finalizePayment(t.db, { orderId: o1.orderId, paymentIntent: 'pi_dup', amountJpy: 1000 }, NOW);
  assert.equal(dup.outcome, 'duplicate_payment');
  assert.equal(q(t, `SELECT count(*) n FROM order_items WHERE order_id='${o1.orderId}'`).n, 2);
  assert.equal(q(t, `SELECT count(*) n FROM v_payments_to_review WHERE order_id='${o1.orderId}'`).n, 1);
  // 二重決済分だけ返金しても、注文は有効なまま
  const dupPay = q(t, `SELECT id FROM payments WHERE stripe_payment_intent='pi_dup'`).id;
  await refundPayment(t.db, { paymentId: dupPay, stripeRefundId: 're_dup' }, NOW);
  assert.equal(q(t, `SELECT status s FROM orders WHERE id='${o1.orderId}'`).s, 'paid');
  assert.ok((await canDownload(t.db, o1.orderToken, 'p1', NOW)).ok);
  assert.equal(q(t, `SELECT count(*) n FROM v_payments_to_review`).n, 1);   // o4 の二重分が残る
});

test('金額不一致は要確認 (DL 不可)。承認すると有効、返金すると無効', async () => {
  const t = seed();
  const o = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW);
  assert.equal((await finalizePayment(t.db, { orderId: o.orderId, paymentIntent: 'pi_m', amountJpy: 999 }, NOW)).outcome, 'needs_review');
  assert.ok(!(await canDownload(t.db, o.orderToken, 'p1', NOW)).ok);
  assert.ok(await approveReviewedOrder(t.db, o.orderId, NOW));
  assert.ok((await canDownload(t.db, o.orderToken, 'p1', NOW)).ok);
  const o2 = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p2'], email: 'b@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: o2.orderId, paymentIntent: 'pi_n', amountJpy: 1 }, NOW);
  await refundPayment(t.db, { paymentId: q(t, `SELECT id FROM payments WHERE stripe_payment_intent='pi_n'`).id }, NOW);
  assert.equal(q(t, `SELECT status s FROM orders WHERE id='${o2.orderId}'`).s, 'refunded');
});

test('ダウンロード期限: 支払い+30日、ただし撮影日+60日まで', async () => {
  const t = seed();
  const o = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: o.orderId, paymentIntent: 'pi_1', amountJpy: 500 }, NOW);
  assert.ok((await canDownload(t.db, o.orderToken, 'p1', new Date('2026-12-10T00:00:00Z'))).ok);
  assert.ok(!(await canDownload(t.db, o.orderToken, 'p1', new Date('2026-12-12T00:00:00Z'))).ok);
});

test('保存期間: 未購入は 30 日で全削除 / 購入済みは期限まで原本を残す / 複数人購入は最も遅い期限', async () => {
  const t = seed();
  const a = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: a.orderId, paymentIntent: 'pi_a', amountJpy: 500 }, NOW);          // 期限 12/11
  const b = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'b@x.jp' }, new Date('2026-12-01T05:00:00Z'));
  await finalizePayment(t.db, { orderId: b.orderId, paymentIntent: 'pi_b', amountJpy: 500 }, new Date('2026-12-01T05:00:00Z')); // 期限は撮影日+60日=1/10 までのうち 12/31
  const kinds = async (d: string) => Object.fromEntries((await photosToPurge(t.db, new Date(d))).map((r) => [r.photoId, r.kind]));
  assert.deepEqual(await kinds('2026-11-20T00:00:00Z'), {});                          // 期間内は何も消えない
  const k1 = await kinds('2026-12-13T00:00:00Z');                                     // 閲覧期間終了後
  assert.equal(k1.p2, 'all'); assert.equal(k1.p1, 'preview_only');                    // p1 は B の期限まで原本を残す
  t.raw.exec(`UPDATE photos SET previews_purged_at='x' WHERE id='p1'`);
  assert.equal((await kinds('2026-12-13T00:00:00Z')).p1, undefined);                  // プレビュー削除済みなら再度出ない
  assert.equal((await kinds('2027-01-05T00:00:00Z')).p1, 'all');                      // 全期限が過ぎれば全削除
  t.raw.exec(`UPDATE groups SET status='deleted' WHERE id='ga'`);
  assert.equal(Object.keys(await kinds('2026-11-12T00:00:00Z')).length, 10);          // 削除依頼は即時全削除
});

test('未決済注文の失効 / 表の整合 (分析ビュー)', async () => {
  const t = seed();
  const a = await createPendingOrder(t.db, { qrToken: 'TOKA', photoIds: ['p1'], email: 'a@x.jp' }, NOW);
  assert.equal(await expirePendingOrders(t.db, 120, new Date('2026-11-11T09:00:00Z')), 1);
  // 失効した注文でも、後から支払いが届けば成立させる (Stripe が正)
  assert.equal((await finalizePayment(t.db, { orderId: a.orderId, paymentIntent: 'pi_late', amountJpy: 500 }, NOW)).outcome, 'paid');

  const pk = await createPendingOrder(t.db, { qrToken: 'TOKA', pack: true, email: 'b@x.jp' }, NOW);
  await finalizePayment(t.db, { orderId: pk.orderId, paymentIntent: 'pi_pk', amountJpy: 2000 }, NOW);
  const v = q(t, `SELECT * FROM v_group_sales WHERE group_id='ga'`);
  assert.deepEqual([v.paid_orders, v.buyers, v.pack_orders, v.revenue_jpy, v.items_sold, v.revenue_per_head_jpy],
                   [2, 2, 1, 2500, 11, 500]);
});
