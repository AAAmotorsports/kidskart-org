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
//   participants?: [{ id, name_snapshot?, kana_snapshot?, birth_date_snapshot?, height_cm? }],
// }
//
// birth_date_snapshot を更新した場合、age_at_booking も自動で再計算して保存する
// (スロット開催日基準の年齢)。
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

  // --- 予約と紐づく guardian_id、slot.date を取得 ------------------------
  // slot.date は birth_date_snapshot 更新時の age_at_booking 再計算で使う。
  const { data: res, error: resErr } = await supabase
    .from('reservations')
    .select('id, guardian_id, slots(date)')
    .eq('id', reservationId)
    .maybeSingle();
  if (resErr) return json({ error: `reservation lookup failed: ${resErr.message}` }, 500);
  if (!res) return json({ error: 'reservation not found' }, 404);
  const slotDate: string | undefined = (res as any).slots?.date;

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
      if ('birth_date_snapshot' in p) {
        const v = typeof p.birth_date_snapshot === 'string' ? p.birth_date_snapshot.trim() : '';
        const validation = validateBirthDate(v, slotDate);
        if (validation.ok) {
          update.birth_date_snapshot = v;
          // 誕生日が変わったら age_at_booking も再計算 (スロット開催日基準)
          if (slotDate) {
            update.age_at_booking = computeAge(v, slotDate);
          }
        } else if (validation.reason) {
          // 明示的な 400 で原因を伝える (DB の 22P02 を素通りさせない)
          return json({ error: `生年月日が不正です (participant ${p.id}): ${validation.reason}` }, 400);
        }
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

/** birth_date (YYYY-MM-DD) 時点から onDate (YYYY-MM-DD) 時点の満年齢 */
function computeAge(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map((n) => parseInt(n, 10));
  const [oy, om, od] = onDate.split('-').map((n) => parseInt(n, 10));
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  return Math.max(0, age);
}

/**
 * birth_date_snapshot のバリデーション。
 * - 'YYYY-MM-DD' 形式
 * - 年は 1900〜現在年 (未来の誕生日は不許可)
 * - 月は 1-12、日は 1-31 (より厳密に実在日付であること、Date で round-trip 確認)
 * - 任意の slotDate より未来だとエラー (参加者が未来生まれは不可)
 */
function validateBirthDate(v: string, slotDate: string | undefined): { ok: boolean; reason?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { ok: false, reason: 'YYYY-MM-DD 形式ではありません' };
  }
  const [y, m, d] = v.split('-').map((n) => parseInt(n, 10));
  const currentYear = new Date().getUTCFullYear();
  if (y < 1900 || y > currentYear) {
    return { ok: false, reason: `年は 1900〜${currentYear} の範囲で指定してください (指定: ${y})` };
  }
  if (m < 1 || m > 12) {
    return { ok: false, reason: `月は 1〜12 の範囲で指定してください (指定: ${m})` };
  }
  if (d < 1 || d > 31) {
    return { ok: false, reason: `日は 1〜31 の範囲で指定してください (指定: ${d})` };
  }
  // round-trip check: 2月30日 等の実在しない日付を弾く
  // Date コンストラクタは 2月30日 → 3月2日 に正規化するので、戻った値が一致するか見る
  const roundTrip = new Date(Date.UTC(y, m - 1, d));
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== m - 1 || roundTrip.getUTCDate() !== d) {
    return { ok: false, reason: `${y}年${m}月${d}日 は存在しない日付です` };
  }
  // slotDate が指定されていて、birth_date が未来 → 未参加の未来児
  if (slotDate && v > slotDate) {
    return { ok: false, reason: `生年月日 (${v}) が開催日 (${slotDate}) より後です` };
  }
  return { ok: true };
}
