import { ShopError, type Db } from './db.ts';
import { calcPrice, type Prices } from './pricing.ts';
import { downloadExpiry, viewEnd } from './time.ts';

const PAYABLE = `('pending','expired','failed','canceled')`;
const ENTITLED = `('paid','partially_refunded')`;

async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function setting<T>(db: Db, key: string): Promise<T> {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return JSON.parse(r!.value) as T;
}

export interface PendingOrder {
  orderId: string; orderToken: string; amountJpy: number; photoCount: number;
  packApplied: boolean; reused: boolean;
}

/**
 * 決済前の注文を作る。サーバー側で購入内容を検証する (クライアントの金額は使わない)。
 *  - グループが公開可 (同意済み・公開中・期間内) か
 *  - 写真がこのグループの公開写真か (他グループの写真 ID は弾く)
 *  - 同じ購入者 (メール) が購入済みの写真を単品で選んでいないか (うっかり二重購入防止)
 *  - 同じ購入者・同じ内容の未決済注文があれば作り直さず再利用 (連打・再読込対策)
 * 他のお客様が購入済みでも、同じ写真は購入できる。
 */
export async function createPendingOrder(
  db: Db,
  input: { qrToken: string; photoIds?: string[]; email: string; pack?: boolean },
  now: Date = new Date(),
): Promise<PendingOrder> {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!email.includes('@') || email.indexOf('@') < 1) throw new ShopError('email_required');

  const g = await db.prepare(
    'SELECT id, status, online_ok, shoot_date FROM groups WHERE qr_token = ?').bind(input.qrToken)
    .first<{ id: string; status: string; online_ok: number; shoot_date: string }>();
  const retention = await setting<{ view_days: number }>(db, 'retention');
  if (!g || g.status !== 'published' || !g.online_ok || now >= viewEnd(g.shoot_date, retention.view_days)) {
    throw new ShopError('group_not_available');
  }

  const all = (await db.prepare(
    `SELECT id FROM photos WHERE group_id = ? AND status = 'ready' ORDER BY taken_at, id`)
    .bind(g.id).all<{ id: string }>()).results.map((r) => r.id);
  if (all.length === 0) throw new ShopError('empty_selection');

  let ids: string[];
  if (input.pack) {
    ids = all;
  } else {
    ids = [...new Set(input.photoIds ?? [])];
    if (ids.length === 0) throw new ShopError('empty_selection');
    const ok = new Set(all);
    if (!ids.every((id) => ok.has(id))) throw new ShopError('photo_not_available');
    const owned = (await db.prepare(
      `SELECT DISTINCT i.photo_id AS id FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.group_id = ? AND o.email = ? AND o.status IN ${ENTITLED}`)
      .bind(g.id, email).all<{ id: string }>()).results.map((r) => r.id);
    const ownedSet = new Set(owned);
    if (ids.some((id) => ownedSet.has(id))) throw new ShopError('already_owned');
  }

  const prices = await setting<Prices>(db, 'prices');
  // パック指定でも写真が少なければ通常計算 (例: 2 枚しか無い団体は 1,000 円)
  const calc = calcPrice(ids.length, prices);
  if (calc.pack) ids = all;

  const cartHash = await sha256Hex(`${calc.pack ? 'PACK' : 'SEL'}:${[...ids].sort().join(',')}`);

  const existing = await db.prepare(
    `SELECT id, order_token, amount_jpy, photo_count, pack_applied FROM orders
      WHERE group_id = ? AND email = ? AND cart_hash = ? AND status = 'pending'`)
    .bind(g.id, email, cartHash)
    .first<{ id: string; order_token: string; amount_jpy: number; photo_count: number; pack_applied: number }>();
  if (existing) {
    return { orderId: existing.id, orderToken: existing.order_token, amountJpy: existing.amount_jpy,
             photoCount: existing.photo_count, packApplied: !!existing.pack_applied, reused: true };
  }

  const orderId = crypto.randomUUID().replaceAll('-', '');
  const orderToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((x) => x.toString(16).padStart(2, '0')).join('');
  const snapshot = JSON.stringify({ prices, selected: ids.length, total_photos: all.length });
  // 注文と明細は 1 batch (原子的)。グループが直前に非公開になっていたら注文は作られず、
  // 明細の外部キー違反で batch ごと取り消される
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO orders(id, order_token, group_id, email, amount_jpy, photo_count, pack_applied,
                            pricing_snapshot, cart_hash, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM groups WHERE id = ? AND status = 'published' AND online_ok = 1)`)
        .bind(orderId, orderToken, g.id, email, calc.amount, ids.length, calc.pack ? 1 : 0,
              snapshot, cartHash, now.toISOString(), now.toISOString(), g.id),
      db.prepare(`INSERT INTO order_items(order_id, photo_id, group_id)
                  SELECT ?, value, ? FROM json_each(?)`).bind(orderId, g.id, JSON.stringify(ids)),
    ]);
  } catch {
    throw new ShopError('group_not_available');
  }
  return { orderId, orderToken, amountJpy: calc.amount, photoCount: ids.length,
           packApplied: calc.pack, reused: false };
}

export type FinalizeOutcome = 'paid' | 'replayed' | 'needs_review' | 'duplicate_payment';

/**
 * 決済確定 (Webhook から。何度呼ばれても結果は同じ)。
 *  1. 支払いを payments に記録 (payment_intent は一意。同じ支払いの再送は 'replayed')
 *  2. 注文が未決済なら条件付き UPDATE で 'paid' に (同時に来ても 1 回だけ成功)
 *  3. 既に決済済みの注文への 2 本目の支払いは 'duplicate_payment' (写真は増えない。管理者が返金)
 *  4. 金額不一致は 'needs_review' (ダウンロードは許可しない)
 */
export async function finalizePayment(
  db: Db,
  p: { orderId: string; sessionId?: string; paymentIntent: string; amountJpy: number },
  now: Date = new Date(),
): Promise<{ outcome: FinalizeOutcome; orderStatus: string }> {
  const o = await db.prepare(
    `SELECT o.id, o.status, o.amount_jpy, g.shoot_date FROM orders o JOIN groups g ON g.id = o.group_id
      WHERE o.id = ?`).bind(p.orderId).first<{ id: string; status: string; amount_jpy: number; shoot_date: string }>();
  if (!o) throw new ShopError('order_not_found');

  const paymentId = crypto.randomUUID().replaceAll('-', '');
  const ins = await db.prepare(
    `INSERT OR IGNORE INTO payments(id, order_id, stripe_session_id, stripe_payment_intent, amount_jpy, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(paymentId, o.id, p.sessionId ?? null, p.paymentIntent, p.amountJpy, now.toISOString()).run();
  if (ins.meta.changes === 0) return { outcome: 'replayed', orderStatus: o.status };

  const ts = now.toISOString();
  if (p.amountJpy !== o.amount_jpy) {
    const u = await db.prepare(
      `UPDATE orders SET status = 'needs_review', review_reason = 'amount_mismatch', updated_at = ?
        WHERE id = ? AND status IN ${PAYABLE}`).bind(ts, o.id).run();
    await db.prepare(`UPDATE payments SET review_reason = ? WHERE id = ?`)
      .bind(u.meta.changes ? 'amount_mismatch' : 'duplicate_payment', paymentId).run();
    return { outcome: u.meta.changes ? 'needs_review' : 'duplicate_payment', orderStatus: u.meta.changes ? 'needs_review' : o.status };
  }

  const ret = await setting<{ purchased_days: number; purchased_max_days: number }>(db, 'retention');
  const exp = downloadExpiry(o.shoot_date, now, ret.purchased_days, ret.purchased_max_days).toISOString();
  const upd = await db.prepare(
    `UPDATE orders SET status = 'paid', paid_at = ?, download_expires_at = ?, paid_payment_id = ?,
            review_reason = NULL, updated_at = ?
      WHERE id = ? AND status IN ${PAYABLE}`).bind(ts, exp, paymentId, ts, o.id).run();
  if (upd.meta.changes === 1) return { outcome: 'paid', orderStatus: 'paid' };

  // 既に決済済み (または返金済み・要確認) の注文への追加の支払い
  await db.prepare(`UPDATE payments SET review_reason = 'duplicate_payment' WHERE id = ?`).bind(paymentId).run();
  const cur = await db.prepare('SELECT status FROM orders WHERE id = ?').bind(o.id).first<{ status: string }>();
  return { outcome: 'duplicate_payment', orderStatus: cur!.status };
}

/** 要確認の注文を管理者が承認する (金額不一致を確認して問題なしとする場合) */
export async function approveReviewedOrder(db: Db, orderId: string, now: Date = new Date()): Promise<boolean> {
  const o = await db.prepare(
    `SELECT o.id, g.shoot_date FROM orders o JOIN groups g ON g.id = o.group_id
      WHERE o.id = ? AND o.status = 'needs_review'`).bind(orderId).first<{ id: string; shoot_date: string }>();
  if (!o) return false;
  const pay = await db.prepare(`SELECT id FROM payments WHERE order_id = ? ORDER BY created_at LIMIT 1`)
    .bind(orderId).first<{ id: string }>();
  if (!pay) return false;
  const ret = await setting<{ purchased_days: number; purchased_max_days: number }>(db, 'retention');
  const exp = downloadExpiry(o.shoot_date, now, ret.purchased_days, ret.purchased_max_days).toISOString();
  const u = await db.prepare(
    `UPDATE orders SET status = 'paid', paid_at = ?, download_expires_at = ?, paid_payment_id = ?,
            review_reason = NULL, updated_at = ? WHERE id = ? AND status = 'needs_review'`)
    .bind(now.toISOString(), exp, pay.id, now.toISOString(), orderId).run();
  await db.prepare(`UPDATE payments SET review_reason = NULL WHERE id = ?`).bind(pay.id).run();
  return u.meta.changes === 1;
}

/**
 * 支払い単位の全額返金 (Stripe 側の返金成功後に呼ぶ)。
 *  - 注文を成立させた支払い (または要確認の注文の支払い) を返金 → その注文だけ 'refunded' (DL 不可)
 *  - 二重決済の支払いを返金 → 注文は 'paid' のまま
 *  他の購入者の注文には一切影響しない。
 */
export async function refundPayment(
  db: Db,
  p: { paymentId: string; stripeRefundId?: string; staffId?: string; reason?: string },
  now: Date = new Date(),
): Promise<void> {
  const pay = await db.prepare(
    `SELECT p.id, p.order_id, p.amount_jpy, p.status, o.paid_payment_id, o.status AS order_status
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`).bind(p.paymentId)
    .first<{ id: string; order_id: string; amount_jpy: number; status: string; paid_payment_id: string | null; order_status: string }>();
  if (!pay) throw new ShopError('payment_not_found');
  if (pay.status === 'refunded') return;
  const ts = now.toISOString();
  const stmts = [
    db.prepare(`INSERT OR IGNORE INTO refunds(payment_id, order_id, stripe_refund_id, amount_jpy, reason, staff_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(pay.id, pay.order_id, p.stripeRefundId ?? null, pay.amount_jpy, p.reason ?? null, p.staffId ?? null, ts),
    db.prepare(`UPDATE payments SET status = 'refunded' WHERE id = ?`).bind(pay.id),
  ];
  const isOrderPayment = pay.paid_payment_id === pay.id || pay.order_status === 'needs_review';
  if (isOrderPayment) {
    stmts.push(db.prepare(`UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(ts, pay.order_id));
  }
  await db.batch(stmts);
}

/** ダウンロードしてよいか。この注文 (購入者) 自身の権限だけで判定する */
export async function canDownload(
  db: Db, orderToken: string, photoId: string, now: Date = new Date(),
): Promise<{ ok: boolean; originalKey?: string }> {
  const r = await db.prepare(
    `SELECT p.original_key AS k FROM orders o
       JOIN order_items i ON i.order_id = o.id AND i.photo_id = ?
       JOIN photos p ON p.id = i.photo_id
       JOIN groups g ON g.id = o.group_id
      WHERE o.order_token = ? AND o.status IN ${ENTITLED} AND o.download_expires_at > ?
        AND p.status IN ('ready','hidden') AND g.status <> 'deleted'`)
    .bind(photoId, orderToken, now.toISOString()).first<{ k: string }>();
  return r ? { ok: true, originalKey: r.k } : { ok: false };
}

/**
 * 保存期間を過ぎた写真 (cron が R2 のファイルを消して status='deleted' にする)。
 *  'all'          原本・プレビュー・サムネすべて
 *  'preview_only' 閲覧期間が終わった購入済み写真 (原本は最後のダウンロード期限まで残す)
 * 同じ写真を複数人が購入していれば、最も遅いダウンロード期限まで原本を残す。
 */
export async function photosToPurge(
  db: Db, now: Date = new Date(),
): Promise<{ photoId: string; groupId: string; kind: 'all' | 'preview_only' }[]> {
  const ret = await setting<{ view_days: number }>(db, 'retention');
  const rows = (await db.prepare(
    `SELECT p.id, p.group_id, p.status AS pstatus, p.previews_purged_at AS pp, g.status AS gstatus, g.shoot_date,
            (SELECT max(o.download_expires_at) FROM order_items i JOIN orders o ON o.id = i.order_id
              WHERE i.photo_id = p.id AND o.status IN ${ENTITLED}) AS last_dl
       FROM photos p JOIN groups g ON g.id = p.group_id WHERE p.status <> 'deleted'`)
    .all<{ id: string; group_id: string; pstatus: string; gstatus: string; shoot_date: string; last_dl: string | null; pp: string | null }>()).results;
  const out: { photoId: string; groupId: string; kind: 'all' | 'preview_only' }[] = [];
  for (const r of rows) {
    const viewOver = now >= viewEnd(r.shoot_date, ret.view_days);
    if (r.gstatus === 'deleted' || r.pstatus === 'pending_delete') out.push({ photoId: r.id, groupId: r.group_id, kind: 'all' });
    else if (r.last_dl === null) { if (viewOver) out.push({ photoId: r.id, groupId: r.group_id, kind: 'all' }); }
    else if (now.toISOString() >= r.last_dl) out.push({ photoId: r.id, groupId: r.group_id, kind: 'all' });
    else if (viewOver && r.pstatus === 'ready' && r.pp === null) out.push({ photoId: r.id, groupId: r.group_id, kind: 'preview_only' });
  }
  return out;
}

/** 決済に至らなかった注文を 'expired' にする (cron) */
export async function expirePendingOrders(db: Db, minutes = 120, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - minutes * 60_000).toISOString();
  const r = await db.prepare(
    `UPDATE orders SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?`)
    .bind(now.toISOString(), cutoff).run();
  return r.meta.changes;
}
