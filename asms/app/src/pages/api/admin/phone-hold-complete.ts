import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { verifySameOrigin } from '@lib/adminAuth';

export const prerender = false;

// POST /api/admin/phone-hold-complete
//
// 電話予約ホールドを iPad 本人記入で完成させる。
//
// 設計方針: 「予約行を再利用して UPDATE in place」。
//   - reservation_number が維持される (お客様への案内と一致)
//   - slot の席数カウントが変動しない (二重確保事故なし)
//   - reservation_id を再利用するので /admin/reception/<id> のリンクが壊れない
//
// 更新対象:
//   - guardians            (reservations.guardian_id 経由で 1 行 UPDATE)
//   - customers            (reservation_participants.customer_id ごとに UPDATE)
//   - reservation_participants (既存行を UPDATE in place)
//   - consents             (append-only 監査ログなので INSERT で 1 行追加)
//   - reservations         (is_phone_hold=FALSE, price_tier, referral_code)
//   - total_amount         (recalculate_reservation_total RPC で単価 × 人数再計算)
//
// 参加人数は増減しない前提 (hold 時点の人数を尊重する)。
//   現場で人数が変わった場合は admin が手動キャンセルして walk-in で作り直す運用。
//
// Body:
//   {
//     hold_reservation_id: uuid,
//     slot_id: uuid,              // walk-in と同じ形。整合性チェックに使う
//     term_id: uuid | null,
//     price_tier: 'member' | 'regular',
//     guardian: { name, kana, phone, email, postal_code?, address? },
//     emergency: { name, phone, relation },
//     participants: Array<{ name, kana, birth_date, gender, height_cm,
//                           photo_consent?: 'allow'|'deny',
//                           kart_experience_note?: string }>,
//     signature: { type: 'drawn'|'typed', image_data?, typed_name? },
//     checked_safety_items: number[],
//   }
//
// Response:
//   { ok: true, reservation_id, reservation_number, total_amount }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const originErr = verifySameOrigin(request);
  if (originErr) return json({ error: `cross-origin blocked: ${originErr}` }, 403);

  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const {
    hold_reservation_id: holdId,
    slot_id: slotId,
    term_id: termIdInput,
    price_tier,
    guardian,
    emergency,
    participants,
    signature,
    checked_safety_items: safetyInput,
  } = body ?? {};

  if (!holdId) return json({ error: 'hold_reservation_id は必須です' }, 400);
  if (!slotId) return json({ error: 'slot_id は必須です' }, 400);
  if (!guardian?.name || !guardian?.phone || !guardian?.email) {
    return json({ error: '保護者情報が不足しています (氏名・電話・メール)' }, 400);
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    return json({ error: '参加者情報が空です' }, 400);
  }
  for (const p of participants) {
    if (!p.name || !p.kana || !p.birth_date || !p.gender || !p.height_cm) {
      return json({ error: '参加者情報に不足があります' }, 400);
    }
  }
  if (!signature || !signature.type) {
    return json({ error: '電子署名が未指定です' }, 400);
  }

  // --- 1) ホールド予約を取得 + 整合性チェック ----------------------------
  const { data: hold, error: holdErr } = await supabase
    .from('reservations')
    .select('id, slot_id, guardian_id, status, is_phone_hold, reservation_number')
    .eq('id', holdId)
    .maybeSingle();
  if (holdErr || !hold) {
    return json({ error: 'ホールド予約が見つかりません', detail: holdErr?.message }, 404);
  }
  if (!hold.is_phone_hold) {
    return json({ error: 'この予約は電話予約ホールドではありません (既に完成済みか別経路)' }, 409);
  }
  if (hold.status === 'cancelled') {
    return json({ error: 'このホールド予約はキャンセル済みです' }, 409);
  }
  if (hold.slot_id !== slotId) {
    return json({ error: 'スロット ID が一致しません', detail: `hold.slot_id=${hold.slot_id} vs payload.slot_id=${slotId}` }, 409);
  }

  // --- 2) 既存の参加者行を取得 (人数が一致することを確認) --------------
  const { data: existingPs, error: psErr } = await supabase
    .from('reservation_participants')
    .select('id, customer_id, created_at')
    .eq('reservation_id', holdId)
    .order('created_at', { ascending: true });
  if (psErr || !existingPs) {
    return json({ error: '既存参加者行の取得に失敗しました', detail: psErr?.message }, 500);
  }
  if (existingPs.length !== participants.length) {
    return json({
      error: '参加人数がホールド時点と一致しません',
      detail: `hold=${existingPs.length} vs iPad=${participants.length}. 人数が変わった場合は本ホールドを管理画面で削除して、改めて当日受付からお願いします。`,
    }, 409);
  }

  // --- 3) 現行 terms を取得 (declaration_text / version / body / hash) --
  const { data: term, error: termErr } = await supabase
    .from('terms')
    .select('id, version, body_markdown, content_hash, safety_items')
    .eq('id', termIdInput ?? '')
    .maybeSingle();
  // termIdInput が null の場合、もしくは hit しない場合は現行 terms を lookup
  let effectiveTerm = term;
  if (termErr || !effectiveTerm) {
    const { data: cur, error: curErr } = await supabase
      .from('terms')
      .select('id, version, body_markdown, content_hash, safety_items')
      .eq('is_current', true)
      .maybeSingle();
    if (curErr || !cur) {
      return json({ error: '現行の利用規約が見つかりません', detail: curErr?.message }, 500);
    }
    effectiveTerm = cur;
  }
  const safetyItems = (effectiveTerm.safety_items as Array<{ id: number }>) ?? [];
  const checkedSafety: number[] = Array.isArray(safetyInput)
    ? safetyInput.map((n: any) => parseInt(n, 10)).filter((n) => Number.isFinite(n))
    : safetyItems.map((it) => it.id);

  // --- 4) guardians を UPDATE in place ---------------------------------
  // touch_updated_at トリガーが updated_at を自動更新するので、ここでは明示的に
  // セットしない (NEW.updated_at = now() で上書きされるため、明示指定は無駄)
  const { error: gErr } = await supabase
    .from('guardians')
    .update({
      name: guardian.name,
      kana: guardian.kana ?? '',
      phone: guardian.phone,
      email: guardian.email,
      postal_code: guardian.postal_code ?? null,
      address: guardian.address ?? null,
      emergency_contact_name: emergency?.name ?? guardian.name,
      emergency_contact_phone: emergency?.phone ?? guardian.phone,
      emergency_contact_relation: emergency?.relation ?? '本人',
    })
    .eq('id', hold.guardian_id);
  if (gErr) {
    console.warn('[phone-hold-complete] guardian update failed:',
      JSON.stringify({ guardian_id: hold.guardian_id, code: (gErr as any).code, message: gErr.message, details: (gErr as any).details, hint: (gErr as any).hint }));
    return json({
      error: '保護者情報の更新に失敗しました',
      detail: `${(gErr as any).code ?? ''} ${gErr.message} ${(gErr as any).hint ?? ''}`.trim(),
    }, 500);
  }

  // --- 5) customers と reservation_participants を 1 対 1 で UPDATE ----
  // ordering を固定するため existingPs を created_at ASC で取得済み。
  // iPad 入力順も表示順と同じ (participantsHost の 1 人目 → N 人目)。
  for (let i = 0; i < existingPs.length; i++) {
    const existing = existingPs[i];
    const p = participants[i];
    const photoConsent = p.photo_consent === 'deny' ? 'deny' : 'allow';

    // age_at_booking は RPC と同じく生年月日から計算 (SQL age() の年部分と等価)
    const ageYears = computeAgeYears(p.birth_date);

    // 5a) customers (永続エンティティ) を本番データで上書き (updated_at はトリガー任せ)
    const { error: cErr } = await supabase
      .from('customers')
      .update({
        name: p.name,
        kana: p.kana,
        birth_date: p.birth_date,
        gender: p.gender,
      })
      .eq('id', existing.customer_id);
    if (cErr) {
      return json({
        error: `参加者 ${i + 1} 人目の顧客情報更新に失敗しました`,
        detail: cErr.message,
      }, 500);
    }

    // 5b) reservation_participants (スナップショット) を本番データで上書き
    const { error: rpErr } = await supabase
      .from('reservation_participants')
      .update({
        name_snapshot: p.name,
        kana_snapshot: p.kana,
        birth_date_snapshot: p.birth_date,
        age_at_booking: ageYears,
        height_cm: p.height_cm,
        gender_snapshot: p.gender,
        kart_experience_note: (p.kart_experience_note ?? '').trim() || null,
        photo_consent: photoConsent,
      })
      .eq('id', existing.id);
    if (rpErr) {
      return json({
        error: `参加者 ${i + 1} 人目のスナップショット更新に失敗しました`,
        detail: rpErr.message,
      }, 500);
    }
  }

  // --- 6) consents に 1 行追加 (append-only 監査ログ) ------------------
  // 元の placeholder consent はそのまま残す (電話受付時点の記録として有効)。
  // 当日 iPad での同意を上乗せするのが正しい挙動。
  const ipHeader = request.headers.get('CF-Connecting-IP') || clientAddress || '';
  const isIpLike = /^[0-9a-fA-F:.]+$/.test(ipHeader); // 乱暴だが INET 用の最低限 filter
  const { error: consentErr } = await supabase
    .from('consents')
    .insert({
      reservation_id: holdId,
      term_id: effectiveTerm.id,
      term_version: effectiveTerm.version,
      term_body_snapshot: effectiveTerm.body_markdown,
      term_hash_snapshot: effectiveTerm.content_hash,
      consenter_name: guardian.name,
      signature_type: signature.type === 'drawn' ? 'drawn' : 'typed',
      signature_typed_name: signature.type === 'typed' ? (signature.typed_name ?? guardian.name) : null,
      signature_image_key: signature.type === 'drawn' ? (signature.image_data ?? null) : null,
      ip_address: isIpLike ? ipHeader : null,
      user_agent: '[phone_hold_complete] ' + (request.headers.get('User-Agent') || ''),
      checked_safety_items: checkedSafety,
      declaration_text: '本規約およびキャンセルポリシー、安全ルール全10項目に同意します。',
    });
  if (consentErr) {
    return json({ error: '同意記録の保存に失敗しました', detail: consentErr.message }, 500);
  }

  // --- 7) reservations: is_phone_hold=FALSE, price_tier, referral_code -
  const tier = price_tier === 'member' ? 'member' : 'regular';
  const { error: resErr } = await supabase
    .from('reservations')
    .update({
      is_phone_hold: false,
      price_tier: tier,
      referral_code: 'PROXY_IPAD',
    })
    .eq('id', holdId);
  if (resErr) {
    return json({ error: '予約フラグの更新に失敗しました', detail: resErr.message }, 500);
  }

  // --- 8) total_amount を再計算 (price_tier 変更が反映される) ---------
  const { data: totalRes, error: totalErr } = await supabase
    .rpc('recalculate_reservation_total', { p_reservation_id: holdId });
  if (totalErr) {
    // 失敗しても予約自体は完成している。warning 返却で admin に目視確認を促す。
    console.warn('[phone-hold-complete] total_amount recalc failed:', totalErr.message);
    return json({
      ok: true,
      warning: `予約は完成しましたが、合計金額の再計算に失敗しました: ${totalErr.message}`,
      reservation_id: holdId,
      reservation_number: hold.reservation_number,
    });
  }

  return json({
    ok: true,
    reservation_id: holdId,
    reservation_number: hold.reservation_number,
    total_amount: totalRes ?? null,
  });
};

// 生年月日から今日時点の年齢 (満年齢) を計算。SQL の age() 年部分と等価。
function computeAgeYears(birthIso: string): number {
  try {
    const b = new Date(birthIso + 'T00:00:00');
    const t = new Date();
    let age = t.getFullYear() - b.getFullYear();
    const m = t.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
    return Math.max(0, age);
  } catch {
    return 0;
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
