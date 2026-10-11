import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/reservation-restore
//
// 誤ってキャンセルされた予約を元に戻す。
//   - reservations.status: 'cancelled' → 'confirmed'
//   - reservations.cancelled_at / cancelled_reason → NULL
//   - reservation_participants.attendance_status: 'cancelled' → 'expected'
//
// 認証: middleware で /api/admin/* は admin cookie 保護済み。
//
// Body: { reservation_id: uuid }
// Response:
//   { ok: true, reservation_status, participants_restored }
//
// 注意:
//   - 既にキャンセル取消済み (status='confirmed') の予約も冪等に通す
//     (エラーにはしない)。
//   - キャンセル時に送信した顧客向け「キャンセル通知」メールは取り消せない。
//     復活したことを顧客に伝える必要があるなら、admin が別途連絡する。
//   - スロットが満席でも復活できる (スタッフ判断で元の予約を優先する運用)。

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
  if (!reservationId) return json({ error: 'reservation_id is required' }, 400);

  // --- 対象予約の確認 ----------------------------------------------------
  const { data: res, error: resErr } = await supabase
    .from('reservations')
    .select('id, status, cancelled_at')
    .eq('id', reservationId)
    .maybeSingle();
  if (resErr) return json({ error: `reservation lookup failed: ${resErr.message}` }, 500);
  if (!res) return json({ error: 'reservation not found' }, 404);

  // --- reservation 本体を復活 --------------------------------------------
  const { error: updErr } = await supabase
    .from('reservations')
    .update({
      status: 'confirmed',
      cancelled_at: null,
      cancelled_reason: null,
    })
    .eq('id', reservationId);
  if (updErr) return json({ error: `reservation restore failed: ${updErr.message}` }, 500);

  // --- 参加者を expected に戻す (cancelled になっているもののみ) -----------
  const { data: restored, error: pErr } = await supabase
    .from('reservation_participants')
    .update({ attendance_status: 'expected' })
    .eq('reservation_id', reservationId)
    .eq('attendance_status', 'cancelled')
    .select('id');
  if (pErr) return json({ error: `participants restore failed: ${pErr.message}` }, 500);

  return json({
    ok: true,
    reservation_status: 'confirmed',
    was_cancelled: res.status === 'cancelled',
    participants_restored: (restored ?? []).length,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
