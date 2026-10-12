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
//   - cancelled 以外のステータス (confirmed / attended / no_show / pending_approval
//     / draft) に対しては 409 で弾く (replay / 誤操作防止)。
//     既に復活済みの予約を叩いたら 409 が返るので、UI 側で冪等扱いしたい場合は
//     409 + current_status を見て判断する。
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

  // --- status gate ---------------------------------------------------------
  // 「復活」は cancelled 予約を元に戻す操作。
  // confirmed / attended / no_show / pending_approval 等に POST された場合、
  // 無条件で status='confirmed' + cancelled_at=null を書くと:
  //   - 出席記録済みの attended / no_show 予約が「予約中」に戻ってしまう
  //   - 元のキャンセル履歴 (cancelled_at, cancelled_reason) が消える
  //   - 承認待ちが承認スキップされて 'confirmed' になる
  // いずれも誤操作ないし replay 攻撃で起こりうる → 明示的に 409 で弾く。
  if ((res as any).status !== 'cancelled') {
    return json({
      error: `この予約は現在 "${(res as any).status}" のため復活対象外です。復活は cancelled 状態の予約のみ可能です。`,
      hint: 'not_cancelled',
      current_status: (res as any).status,
    }, 409);
  }

  // --- 復活対象の参加者を特定 ----------------------------------------------
  // 「予約全体キャンセルで同時に失われた参加者」だけ戻す。
  // それ以前の個別キャンセル (= 保護者が部分キャンセルした人) は
  // そのまま cancelled のままにする (over-restoration 防止)。
  //
  // 判定: 参加者の cancelled_at >= 予約の cancelled_at
  // (= 予約キャンセル時 or その後に cancelled になった = 予約全体キャンセル由来)
  //
  // レガシー互換: 0037 migration 前のキャンセル or 一部の slot-wide cancel path
  // は reservations.cancelled_at / participants.cancelled_at に NULL が残っている
  // 可能性がある。この場合は「部分キャンセル情報が無い」ので、cancelled 参加者を
  // 全員復活する (= 全体キャンセルと見なす) 方が実用的。
  // 「status=confirmed なのに参加者 0 名」の壊れ状態を防ぐ。
  const resCancelledAt: string | null = (res as any).cancelled_at ?? null;

  const { data: allCancelled, error: fetchErr } = await supabase
    .from('reservation_participants')
    .select('id, cancelled_at')
    .eq('reservation_id', reservationId)
    .eq('attendance_status', 'cancelled');
  if (fetchErr) return json({ error: `participant fetch failed: ${fetchErr.message}` }, 500);

  const toRestore: string[] = [];
  const preCancelled: string[] = [];
  const cancelledRows = (allCancelled ?? []) as Array<{ id: string; cancelled_at: string | null }>;

  if (!resCancelledAt) {
    // レガシー: 予約側に cancelled_at が無いので「どれが部分キャンセルか」判別不能
    // → 全員復活 (全体キャンセル扱い)
    for (const p of cancelledRows) toRestore.push(p.id);
  } else {
    for (const p of cancelledRows) {
      // participant 側の cancelled_at が NULL = レガシー行は「全体キャンセル」側に倒す
      // (個別キャンセルは 0037 以降必ず cancelled_at が入る前提)
      if (!p.cancelled_at || p.cancelled_at >= resCancelledAt) {
        toRestore.push(p.id);
      } else {
        preCancelled.push(p.id);
      }
    }
  }

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

  // --- 対象参加者だけ expected に戻す (cancelled_at も NULL に) --------------
  if (toRestore.length > 0) {
    const { error: pErr } = await supabase
      .from('reservation_participants')
      .update({ attendance_status: 'expected', cancelled_at: null })
      .in('id', toRestore);
    if (pErr) return json({ error: `participants restore failed: ${pErr.message}` }, 500);
  }

  // --- total_amount を 原子的に再計算 (RPC) ------------------------------
  // active = expected + attended + no_show。復活した参加者は expected 扱いで
  // カウントされる。先に個別キャンセルされていた人は cancelled のままなので
  // 料金に含まれない。
  const { data: newTotal, error: rtErr } = await supabase
    .rpc('recalculate_reservation_total', { p_reservation_id: reservationId });
  if (rtErr) return json({ error: `total_amount recalc failed: ${rtErr.message}` }, 500);

  return json({
    ok: true,
    reservation_status: 'confirmed',
    participants_restored: toRestore.length,
    participants_kept_cancelled: preCancelled.length,
    new_total_amount: newTotal,
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
