import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/reservation-attendance
//
// 予約内の全参加者の attendance_status を一括更新する JSON API。
// /admin/reception/[reservationId] の「受付完了」/「無断欠席」ボタンから叩かれる。
//
// 認証: middleware で /api/admin/* は admin cookie 保護済み。
//
// 既存の attendance 更新 (/admin/slots/[id] の set_attendance) は
// participant 単位の form POST で、受付画面の fetch からは直接叩きにくい。
// こちらは「reservation 単位で全員同じ status に」を 1 UPDATE で済ませる。
//
// Body: { reservation_id: uuid, status: 'expected' | 'attended' | 'no_show' | 'cancelled' }
// Response: { ok: true, updated: number }

const ALLOWED_STATUSES = new Set(['expected', 'attended', 'no_show', 'cancelled']);

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
  const status: string | undefined = body?.status;
  if (!reservationId) return json({ error: 'reservation_id is required' }, 400);
  if (!status || !ALLOWED_STATUSES.has(status)) {
    return json({ error: `status must be one of ${[...ALLOWED_STATUSES].join('|')}` }, 400);
  }

  // 対象予約が存在するか確認 (invalid UUID だと UPDATE が無声エラーで落ちる)
  const { data: res, error: resErr } = await supabase
    .from('reservations')
    .select('id')
    .eq('id', reservationId)
    .maybeSingle();
  if (resErr) return json({ error: `reservation lookup failed: ${resErr.message}` }, 500);
  if (!res) return json({ error: 'reservation not found' }, 404);

  // cancelled 参加者は触らない (既にキャンセル済みのを「出席」に戻すのは意図しない操作)。
  // 「全員出席」なら残りの参加者 (expected/attended/no_show) を attended に。
  const { data: updated, error: updErr } = await supabase
    .from('reservation_participants')
    .update({ attendance_status: status })
    .eq('reservation_id', reservationId)
    .neq('attendance_status', 'cancelled')
    .select('id');
  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500);

  return json({ ok: true, updated: (updated ?? []).length });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
