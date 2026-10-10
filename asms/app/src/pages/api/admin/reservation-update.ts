import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/reservation-update
//
// 受付画面 (/admin/reception/[reservationId]) の編集モードから叩かれる。
// お客様が入力した情報の typo・住所間違い・身長変化などを現場で直す用。
//
// 認証: middleware で /api/admin/* は admin cookie 保護済み。
//
// Body:
// {
//   reservation_id: uuid,
//   guardian?: { name?, kana?, phone?, email?, address? },  -- 保護者 (guardians テーブル)
//   participants?: [{ id, name_snapshot?, kana_snapshot?, height_cm? }],
// }
//
// 設計方針:
//   - guardian は値が与えられたフィールドだけ update (null/'' は空文字で上書き)
//   - participants は参加者ごとに id をキーに個別 update
//   - name_snapshot / kana_snapshot も編集可能にしておく (typo 対応)
//     (本来の snapshot 思想からは外れるが、現場運用の実用性を優先)
//   - height_cm も編集可能 (子供が伸びた等)
//   - 失敗時は 500 でエラーメッセージを返す

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

  // --- 予約と紐づく guardian_id を取得 -----------------------------------
  const { data: res, error: resErr } = await supabase
    .from('reservations')
    .select('id, guardian_id')
    .eq('id', reservationId)
    .maybeSingle();
  if (resErr) return json({ error: `reservation lookup failed: ${resErr.message}` }, 500);
  if (!res) return json({ error: 'reservation not found' }, 404);

  const results: Record<string, any> = { guardian: null, participants: [] };

  // --- Guardian 更新 ------------------------------------------------------
  if (body.guardian && typeof body.guardian === 'object') {
    const g = body.guardian;
    const update: Record<string, string | null> = {};
    for (const k of ['name', 'kana', 'phone', 'email', 'address'] as const) {
      if (k in g) {
        const v = g[k];
        update[k] = typeof v === 'string' ? v.trim() : v == null ? null : String(v);
      }
    }
    if (Object.keys(update).length > 0 && res.guardian_id) {
      const { error: gErr } = await supabase
        .from('guardians')
        .update(update)
        .eq('id', res.guardian_id);
      if (gErr) return json({ error: `guardian update failed: ${gErr.message}` }, 500);
      results.guardian = { updated_fields: Object.keys(update) };
    }
  }

  // --- Participants 更新 ---------------------------------------------------
  if (Array.isArray(body.participants)) {
    for (const p of body.participants) {
      if (!p?.id) continue;
      const update: Record<string, any> = {};
      if ('name_snapshot' in p) {
        const v = typeof p.name_snapshot === 'string' ? p.name_snapshot.trim() : '';
        if (v) update.name_snapshot = v;
      }
      if ('kana_snapshot' in p) {
        const v = typeof p.kana_snapshot === 'string' ? p.kana_snapshot.trim() : '';
        if (v) update.kana_snapshot = v;
      }
      if ('height_cm' in p) {
        const n = parseInt(String(p.height_cm), 10);
        if (!isNaN(n) && n >= 50 && n <= 220) update.height_cm = n;
      }
      if (Object.keys(update).length === 0) continue;

      // 他予約への誤爆防止: この予約の参加者であることを eq で縛る
      const { error: pErr } = await supabase
        .from('reservation_participants')
        .update(update)
        .eq('id', p.id)
        .eq('reservation_id', reservationId);
      if (pErr) return json({ error: `participant ${p.id} update failed: ${pErr.message}` }, 500);
      results.participants.push({ id: p.id, updated_fields: Object.keys(update) });
    }
  }

  return json({ ok: true, ...results });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
