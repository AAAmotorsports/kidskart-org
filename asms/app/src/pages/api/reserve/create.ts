import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/reserve/create
//
// Atomic-ish creation of a reservation from the customer wizard.
// The individual INSERTs aren't wrapped in a single Postgres transaction
// (supabase-js has no first-class BEGIN/COMMIT), so a failure between
// steps can leave orphans. For MVP volume this is acceptable — orphaned
// guardians/customers without a reservation can be cleaned up by an
// admin job later. The critical uniqueness (slot capacity, reservation
// number) is still guarded by DB constraints.
//
// Payload shape (validated shallowly here — client-side wizard is the
// primary UX filter, this is defence in depth):
//
// {
//   slot_id: uuid,
//   term_id: uuid,
//   price_tier: 'regular' | 'member',
//   participants: [{ name, kana, birth_date, gender, height_cm,
//                    kart_experience_note?, photo_consent }, ...],
//   guardian: { name, kana, phone, email, postal_code?, address? },
//   emergency: { name, phone, relation },
//   signature: { type: 'drawn', image_data } | { type: 'typed', typed_name },
//   checked_safety_items: number[]
// }

export const POST: APIRoute = async ({ request, locals, clientAddress }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const {
    slot_id,
    term_id,
    price_tier,
    participants,
    guardian,
    emergency,
    signature,
    checked_safety_items,
  } = body ?? {};

  if (!slot_id || !term_id) return json({ error: 'slot_id と term_id は必須です' }, 400);
  if (!Array.isArray(participants) || participants.length === 0) {
    return json({ error: '参加者情報が空です' }, 400);
  }
  if (!guardian?.name || !guardian?.phone || !guardian?.email) {
    return json({ error: '保護者情報が不足しています' }, 400);
  }
  if (!emergency?.name || !emergency?.phone) {
    return json({ error: '緊急連絡先が不足しています' }, 400);
  }
  if (!signature?.type) return json({ error: '署名情報が不足しています' }, 400);
  if (signature.type === 'drawn' && !signature.image_data) {
    return json({ error: '署名が空です' }, 400);
  }
  if (signature.type === 'typed' && !signature.typed_name) {
    return json({ error: '署名（タイプ）が空です' }, 400);
  }
  if (!Array.isArray(checked_safety_items)) {
    return json({ error: '安全項目のチェックが不足しています' }, 400);
  }

  // --- Load slot + course ------------------------------------------------
  const { data: slot, error: slotErr } = await supabase
    .from('slots')
    .select('id, date, start_time, capacity, status, course_id, courses(id, code, name, price_regular, price_member, requires_approval)')
    .eq('id', slot_id)
    .maybeSingle();
  if (slotErr) return json({ error: 'slot lookup failed', detail: slotErr.message }, 500);
  if (!slot) return json({ error: '指定の枠が見つかりません' }, 404);
  if (slot.status !== 'open') return json({ error: 'この枠は現在受付停止中です' }, 409);

  const course: any = slot.courses ?? {};

  // --- Capacity guard (TOCTOU race remains but slot capacity is the
  //     final backstop — a real overbook would surface here as > capacity
  //     after the fact and needs admin cleanup). ---------------------------
  const { data: existingRes } = await supabase
    .from('reservations')
    .select('id')
    .eq('slot_id', slot_id)
    .neq('status', 'cancelled');
  const resIds = (existingRes ?? []).map((r) => r.id);
  let reserved = 0;
  if (resIds.length > 0) {
    const { count } = await supabase
      .from('reservation_participants')
      .select('*', { count: 'exact', head: true })
      .in('reservation_id', resIds);
    reserved = count ?? 0;
  }
  if (reserved + participants.length > slot.capacity) {
    return json({
      error: `満席のため受付できません（残 ${Math.max(0, slot.capacity - reserved)} 名）`,
    }, 409);
  }

  // --- Load current terms for snapshot ----------------------------------
  const { data: term } = await supabase
    .from('terms')
    .select('id, version, body_markdown, content_hash')
    .eq('id', term_id)
    .maybeSingle();
  if (!term) return json({ error: '利用規約バージョンが見つかりません' }, 400);

  // --- Insert guardian --------------------------------------------------
  const { data: gRow, error: gErr } = await supabase
    .from('guardians')
    .insert({
      name: guardian.name,
      kana: guardian.kana,
      phone: guardian.phone,
      email: guardian.email,
      postal_code: guardian.postal_code || null,
      address: guardian.address || null,
      emergency_contact_name: emergency.name,
      emergency_contact_phone: emergency.phone,
      emergency_contact_relation: emergency.relation || null,
    })
    .select('id')
    .single();
  if (gErr || !gRow) return json({ error: '保護者情報の登録に失敗しました', detail: gErr?.message }, 500);

  // --- Insert one customer per participant -------------------------------
  const customerIds: string[] = [];
  for (const p of participants) {
    if (!p.name || !p.kana || !p.birth_date || !p.gender || !p.height_cm) {
      return json({ error: '参加者情報に不足があります' }, 400);
    }
    const customerNumber = 'C-' +
      Date.now().toString(36).toUpperCase() + '-' +
      Math.floor(Math.random() * 100000).toString().padStart(5, '0');
    const { data: c, error: cErr } = await supabase
      .from('customers')
      .insert({
        customer_number: customerNumber,
        name: p.name,
        kana: p.kana,
        birth_date: p.birth_date,
        gender: p.gender,
      })
      .select('id')
      .single();
    if (cErr || !c) {
      return json({ error: '顧客情報の登録に失敗しました', detail: cErr?.message }, 500);
    }
    customerIds.push(c.id);
  }

  // --- Guardian ↔ customers links ---------------------------------------
  for (const cid of customerIds) {
    await supabase.from('guardian_customer_links').insert({
      guardian_id: gRow.id,
      customer_id: cid,
      relation: emergency.relation || '保護者',
      is_primary: true,
    });
  }

  // --- Compute pricing + approval flag ----------------------------------
  const perPersonPrice = price_tier === 'member' ? course.price_member : course.price_regular;
  const totalAmount = (perPersonPrice ?? 0) * participants.length;
  const requiresApproval = !!course.requires_approval;
  const status = requiresApproval ? 'pending_approval' : 'confirmed';

  // --- Insert reservation -----------------------------------------------
  const { data: rRow, error: rErr } = await supabase
    .from('reservations')
    .insert({
      slot_id: slot.id,
      guardian_id: gRow.id,
      status,
      price_tier: price_tier === 'member' ? 'member' : 'regular',
      total_amount: totalAmount,
    })
    .select('id, reservation_number')
    .single();
  if (rErr || !rRow) {
    return json({ error: '予約の登録に失敗しました', detail: rErr?.message }, 500);
  }

  // --- Insert participants snapshot -------------------------------------
  const ageAtBooking = (bd: string) => {
    const now = new Date();
    const b = new Date(bd);
    let a = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
    return Math.max(0, a);
  };
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    const { error: pErr } = await supabase.from('reservation_participants').insert({
      reservation_id: rRow.id,
      customer_id: customerIds[i],
      name_snapshot: p.name,
      kana_snapshot: p.kana,
      birth_date_snapshot: p.birth_date,
      age_at_booking: ageAtBooking(p.birth_date),
      height_cm: p.height_cm,
      gender_snapshot: p.gender,
      kart_experience_note: p.kart_experience_note || null,
      photo_consent: p.photo_consent || 'allow',
    });
    if (pErr) {
      return json({ error: '参加者スナップショットの登録に失敗しました', detail: pErr.message }, 500);
    }
  }

  // --- Consent record (append-only) -------------------------------------
  const { error: consentErr } = await supabase.from('consents').insert({
    reservation_id: rRow.id,
    term_id: term.id,
    term_version: term.version,
    term_body_snapshot: term.body_markdown,
    term_hash_snapshot: term.content_hash,
    consenter_name: guardian.name,
    signature_type: signature.type,
    signature_typed_name: signature.type === 'typed' ? signature.typed_name : null,
    signature_image_key: signature.type === 'drawn' ? signature.image_data : null,
    ip_address: request.headers.get('CF-Connecting-IP') || clientAddress || null,
    user_agent: request.headers.get('User-Agent') || null,
    checked_safety_items,
    declaration_text: '本規約およびキャンセルポリシー、安全ルール全10項目に同意します。',
  });
  if (consentErr) {
    return json({ error: '同意履歴の登録に失敗しました', detail: consentErr.message }, 500);
  }

  return json({
    ok: true,
    reservation_id: rRow.id,
    reservation_number: rRow.reservation_number,
    status,
  });
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
