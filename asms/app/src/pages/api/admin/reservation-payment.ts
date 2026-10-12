import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/reservation-payment
//
// 予約の会計情報 (payment_method / paid_amount / paid_at) を記録する JSON API。
// /admin/reception/[reservationId] の「会計を記録」ボタンから叩かれる。
//
// 既存の record_payment (admin/slots/[id] の form POST) と等価だが、受付画面の
// fetch から呼べるように JSON 版を分離。
//
// Body:
//   { reservation_id: uuid,
//     payment_method: 'cash'|'paypay'|'credit'|'other',
//     paid_amount: number (yen),
//     payment_note?: string }
// Response: { ok: true, paid_at: ISO string }

const ALLOWED_METHODS = new Set(['cash', 'paypay', 'credit', 'other']);

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const reservationId: string | undefined = body?.reservation_id;
  const method: string | undefined = body?.payment_method;
  const amountRaw = body?.paid_amount;
  // 'payment_note' が body に含まれているときだけ更新。
  // キー自体が無いときは既存 note を上書きしない (受付画面などの軽量 UI は
  // note を送らないため、/admin/slots/[id] で手書きした note が消えないように)。
  const noteFieldPresent = Object.prototype.hasOwnProperty.call(body ?? {}, 'payment_note');
  const noteRaw = body?.payment_note;

  if (!reservationId) return json({ error: 'reservation_id is required' }, 400);
  if (!method || !ALLOWED_METHODS.has(method)) {
    return json({ error: `payment_method must be one of ${[...ALLOWED_METHODS].join('|')}` }, 400);
  }
  const amount = typeof amountRaw === 'number'
    ? Math.round(amountRaw)
    : parseInt(String(amountRaw ?? '').replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return json({ error: 'paid_amount must be a non-negative integer' }, 400);
  }

  // 対象予約が存在するか確認
  const { data: res, error: resErr } = await supabase
    .from('reservations')
    .select('id, status')
    .eq('id', reservationId)
    .maybeSingle();
  if (resErr) return json({ error: `reservation lookup failed: ${resErr.message}` }, 500);
  if (!res) return json({ error: 'reservation not found' }, 404);
  if ((res as any).status === 'cancelled') {
    return json({ error: 'cannot record payment on cancelled reservation' }, 409);
  }

  const paidAt = new Date().toISOString();
  const update: Record<string, unknown> = {
    payment_method: method,
    paid_amount: amount,
    paid_at: paidAt,
  };
  if (noteFieldPresent) {
    // 明示的に空文字 or null を送った場合は note クリア、文字列あれば 500 字で truncate
    update.payment_note = typeof noteRaw === 'string'
      ? (noteRaw.trim().slice(0, 500) || null)
      : null;
  }

  const { error: updErr } = await supabase
    .from('reservations')
    .update(update)
    .eq('id', reservationId);

  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500);

  return json({ ok: true, paid_at: paidAt, payment_method: method, paid_amount: amount });
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
