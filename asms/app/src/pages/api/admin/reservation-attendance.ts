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

  // --- reservations.status を参加者の集約結果に同期 ------------------------
  // 目的: 将来のダッシュボードや cron がステータスをキーに集計するときに
  //       「全員 no_show なのに reservations.status='confirmed' のまま」等の
  //       ドリフトを防ぐ。
  //
  // 判定ルール (非 cancelled 参加者のみ対象、cancelled は除外):
  //   - 残参加者が 0 (= 全員が cancelled) → reservation.status には触らない
  //     (キャンセルは別経路 /api/reserve/cancel で status='cancelled' を書く)
  //   - 非 cancelled 全員が同じステータス (attended / no_show) → 同じ値に同期
  //   - 混在 → reservation.status = 'confirmed' に戻す
  //     (以前「全員 attended」で確定していたのを 1 人だけ expected に戻した場合)
  //
  // reservation_status enum は 'draft' | 'pending_approval' | 'confirmed' |
  //   'attended' | 'no_show' | 'cancelled' を含む (0001_initial_schema.sql:44-47)
  const { data: allParts, error: pErr } = await supabase
    .from('reservation_participants')
    .select('attendance_status')
    .eq('reservation_id', reservationId);
  if (pErr) return json({ error: `participants fetch failed: ${pErr.message}` }, 500);

  const activeStatuses = (allParts ?? [])
    .map((p: any) => p.attendance_status)
    .filter((s: string) => s !== 'cancelled');

  let resStatusTarget: 'confirmed' | 'attended' | 'no_show' | null = null;
  if (activeStatuses.length === 0) {
    // 残 0: この API は cancelled 参加者を触らないので、ここに来るのは
    // 前段で全員 cancelled 状態の予約を叩いた場合。何もしない。
    resStatusTarget = null;
  } else if (activeStatuses.every((s) => s === 'attended')) {
    resStatusTarget = 'attended';
  } else if (activeStatuses.every((s) => s === 'no_show')) {
    resStatusTarget = 'no_show';
  } else {
    // expected と attended の混在、attended と no_show の混在など
    resStatusTarget = 'confirmed';
  }

  let reservation_status_updated: string | null = null;
  if (resStatusTarget) {
    // 現在値を確認して、必要な時だけ UPDATE (無駄な WAL を避けつつ
    // cancelled / pending_approval 予約の status を上書きしてしまう事故も予防)。
    const { data: curRes } = await supabase
      .from('reservations')
      .select('status')
      .eq('id', reservationId)
      .maybeSingle();
    const curStatus = (curRes as any)?.status;
    // cancelled: キャンセル予約の状態は触らない (別経路で管理)
    // pending_approval: 承認待ちは管理者承認を経て 'confirmed' になるべきで、
    //                   attendance 操作で勝手に 'confirmed' に昇格させない。
    //                   承認後 (status='confirmed') で改めて attendance 入力時に同期される。
    const PROTECTED = new Set(['cancelled', 'pending_approval', 'draft']);
    if (curStatus && !PROTECTED.has(curStatus) && curStatus !== resStatusTarget) {
      const { error: rErr } = await supabase
        .from('reservations')
        .update({ status: resStatusTarget })
        .eq('id', reservationId)
        // 二重防御: UPDATE 時点でも cancelled/pending には触らない
        .not('status', 'in', '(cancelled,pending_approval,draft)');
      if (rErr) {
        console.warn('[reservation-attendance] status sync failed:', rErr.message);
      } else {
        reservation_status_updated = resStatusTarget;
      }
    }
  }

  return json({
    ok: true,
    updated: (updated ?? []).length,
    reservation_status_updated,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
