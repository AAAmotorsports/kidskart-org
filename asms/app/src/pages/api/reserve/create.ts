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

  // --- Guardian dedup: match by lower-cased email --------------------------
  // Same email ≒ same person. Not perfect (typos, shared addresses) but
  // prevents the "each booking creates a new guardian row" bloat we saw
  // in early testing. If contact info drifted since last time (address
  // change etc.), UPDATE the existing row so the karte reflects current
  // reality.
  const guardianEmail = (guardian.email ?? '').trim();
  let guardianId: string | null = null;
  if (guardianEmail) {
    const { data: existing } = await supabase
      .from('guardians')
      .select('id')
      .ilike('email', guardianEmail)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      const { error: uErr } = await supabase
        .from('guardians')
        .update({
          name: guardian.name,
          kana: guardian.kana,
          phone: guardian.phone,
          postal_code: guardian.postal_code || null,
          address: guardian.address || null,
          emergency_contact_name: emergency.name,
          emergency_contact_phone: emergency.phone,
          emergency_contact_relation: emergency.relation || null,
        })
        .eq('id', existing.id);
      if (uErr) return json({ error: `保護者情報の更新に失敗しました: ${uErr.message}`, detail: uErr.details }, 500);
      guardianId = existing.id;
    }
  }
  if (!guardianId) {
    const { data: gRow, error: gErr } = await supabase
      .from('guardians')
      .insert({
        name: guardian.name,
        kana: guardian.kana,
        phone: guardian.phone,
        email: guardianEmail,
        postal_code: guardian.postal_code || null,
        address: guardian.address || null,
        emergency_contact_name: emergency.name,
        emergency_contact_phone: emergency.phone,
        emergency_contact_relation: emergency.relation || null,
      })
      .select('id')
      .single();
    if (gErr || !gRow) return json({ error: `保護者情報の登録に失敗しました: ${gErr?.message ?? '不明'}`, detail: gErr?.details }, 500);
    guardianId = gRow.id;
  }

  // --- Customer dedup: reuse an existing customer if same guardian has
  //     already registered a child with the exact same (name, kana,
  //     birth_date) triplet. Two different families with a same-named
  //     same-birthday child would collide only within one guardian scope,
  //     which is unlikely enough for MVP. Same guardian, different kana
  //     writing would miss and create a dup — admin can merge later.
  const customerIds: string[] = [];
  for (const p of participants) {
    if (!p.name || !p.kana || !p.birth_date || !p.gender || !p.height_cm) {
      return json({ error: '参加者情報に不足があります' }, 400);
    }
    const { data: linkedCustomers } = await supabase
      .from('guardian_customer_links')
      .select('customer_id, customers(id, name, kana, birth_date, is_deleted)')
      .eq('guardian_id', guardianId);
    const reused = (linkedCustomers ?? []).find((l: any) => {
      const c = l.customers;
      return c && !c.is_deleted
        && c.name === p.name
        && c.kana === p.kana
        && c.birth_date === p.birth_date;
    });
    if (reused) {
      customerIds.push((reused as any).customers.id);
      continue;
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
      return json({ error: `顧客情報の登録に失敗しました: ${cErr?.message ?? '不明'}`, detail: cErr?.details }, 500);
    }
    customerIds.push(c.id);

    // Only create the link for newly-inserted customers; existing links
    // are preserved on reuse.
    await supabase.from('guardian_customer_links').insert({
      guardian_id: guardianId,
      customer_id: c.id,
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
      guardian_id: guardianId,
      status,
      price_tier: price_tier === 'member' ? 'member' : 'regular',
      total_amount: totalAmount,
    })
    .select('id, reservation_number')
    .single();
  if (rErr || !rRow) {
    return json({
      error: `予約の登録に失敗しました: ${rErr?.message ?? '不明なエラー'}`,
      detail: `${rErr?.code ?? ''} ${rErr?.details ?? ''} ${rErr?.hint ?? ''}`.trim(),
    }, 500);
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

  // --- Fire-and-forget confirmation email (Resend) ---------------------
  // Wrapped in ctx.waitUntil so Cloudflare Workers keeps the async fetch
  // alive after we return the response. Without waitUntil the runtime
  // cancels pending work as soon as the response is sent, which silently
  // drops the email AND the console output.
  const apiUrl = new URL(request.url);
  const emailPromise = sendConfirmationEmail(env, {
    to: guardianEmail,
    guardianName: guardian.name,
    reservationNumber: rRow.reservation_number,
    status,
    dateIso: slot.date,
    startTime: slot.start_time,
    endTime: slot.end_time,
    courseName: course.name,
    participants: participants.map((p: any) => p.name),
    totalAmount,
    priceTier: price_tier,
    origin: `${apiUrl.protocol}//${apiUrl.host}`,
    reservationId: rRow.id,
  }).catch((e) => console.warn('[reserve/create] email send failed:', e));

  const runtimeCtx = (locals as any).runtime?.ctx;
  if (runtimeCtx && typeof runtimeCtx.waitUntil === 'function') {
    runtimeCtx.waitUntil(emailPromise);
  } else {
    console.warn('[reserve/create] no runtime.ctx.waitUntil — email may be cancelled after response');
  }

  return json({
    ok: true,
    reservation_id: rRow.id,
    reservation_number: rRow.reservation_number,
    status,
  });
};

async function sendConfirmationEmail(env: Env, args: {
  to: string;
  guardianName: string;
  reservationNumber: string;
  status: string;
  dateIso: string;
  startTime: string;
  endTime: string | null;
  courseName: string;
  participants: string[];
  totalAmount: number;
  priceTier: string;
  origin: string;
  reservationId: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  const envKeys = Object.keys(env).sort();
  if (!apiKey) {
    console.warn('[reserve/create] SKIP email: RESEND_API_KEY not set in runtime env. Available env keys:', envKeys);
    return;
  }
  if (!args.to) {
    console.warn('[reserve/create] SKIP email: no recipient address');
    return;
  }
  console.log('[reserve/create] sending email to', args.to, 'via Resend (key ends with', apiKey.slice(-4), ')');
  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';
  const replyTo = env.MAIL_REPLY_TO || undefined;

  const isPending = args.status === 'pending_approval';
  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(args.dateIso + 'T00:00:00');
  const dateLabel = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJa[d.getDay()]})`;
  const timeLabel = `${args.startTime.slice(0, 5)}${args.endTime ? '–' + args.endTime.slice(0, 5) : ''}`;

  const [h, m] = args.startTime.split(':').map(Number);
  const totalMin = Math.max(0, h * 60 + m - 15);
  const checkIn = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;

  const subject = isPending
    ? `【承認待ち】ご予約を受付けました — ${args.reservationNumber}`
    : `【予約確定】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName} — ${args.reservationNumber}`;

  const detailUrl = `${args.origin}/reserve/complete/${args.reservationId}`;

  const text = [
    `${args.guardianName} 様`,
    '',
    isPending
      ? '福岡キッズカートアカデミーへのご予約を受付けました。'
      : 'ご予約が確定しました。ご参加をお待ちしております。',
    '',
    `▼ 予約内容`,
    `予約番号: ${args.reservationNumber}`,
    `状態: ${isPending ? '承認待ち' : '確定'}`,
    `コース: ${args.courseName}`,
    `日付: ${dateLabel}`,
    `時間: ${timeLabel}`,
    `受付開始: ${checkIn}（開始15分前）`,
    `参加者: ${args.participants.join('・')} (${args.participants.length}名)`,
    `料金: ¥${args.totalAmount.toLocaleString()}（${args.priceTier === 'member' ? '会員' : '一般'}）`,
    '',
    `▼ 予約詳細ページ`,
    detailUrl,
    '',
    isPending
      ? '当社確認のうえ、あらためて確定通知をお送りします。'
      : '当日は動きやすい服装（長袖・長ズボン・運動靴）でお越しください。ヘルメット・グローブは貸出可能です。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '📞 092-927-1177',
    '🌐 https://kidskart.org/',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">${isPending ? '⏳' : '✅'}</div>
    <h2 style="text-align:center;margin:0 0 .4rem;font-size:1.2rem">${isPending ? 'ご予約を受付けました' : 'ご予約が確定しました'}</h2>
    <p style="text-align:center;margin:0 0 1rem;color:#3d556f;font-size:.9rem">${escapeHtml(args.guardianName)} 様</p>
    <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin-bottom:1rem">
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700">予約番号</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;color:#1a7fb8;font-weight:800">${escapeHtml(args.reservationNumber)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">状態</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0">${isPending ? '<span style="background:rgba(255,201,67,.2);color:#e5631a;padding:2px 8px;border-radius:100px;font-weight:800;font-size:.74rem">承認待ち</span>' : '<span style="background:rgba(164,214,94,.2);color:#7eb13a;padding:2px 8px;border-radius:100px;font-weight:800;font-size:.74rem">確定</span>'}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">コース</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0">${escapeHtml(args.courseName)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">日付</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;border-top:1px dashed #d8e6f0">${escapeHtml(dateLabel)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">時間</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;border-top:1px dashed #d8e6f0">${escapeHtml(timeLabel)}</td></tr>
      <tr style="background:rgba(255,201,67,.1)"><td style="padding:.5rem .5rem;color:#7d8fa0;font-size:.74rem;font-weight:700">受付開始</td><td style="padding:.5rem .5rem;text-align:right;font-family:monospace;color:#e5631a;font-weight:800">${escapeHtml(checkIn)} <span style="font-size:.68rem;color:#7d8fa0;font-weight:400;font-family:sans-serif">（開始15分前）</span></td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">参加者</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0">${escapeHtml(args.participants.join('・'))} (${args.participants.length}名)</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.74rem;font-weight:700;border-top:1px dashed #d8e6f0">料金</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;border-top:1px dashed #d8e6f0">¥${args.totalAmount.toLocaleString()}（${args.priceTier === 'member' ? '会員' : '一般'}）</td></tr>
    </table>
    <p style="text-align:center;margin:1rem 0">
      <a href="${detailUrl}" style="display:inline-block;padding:.7rem 1.4rem;background:linear-gradient(135deg,#ff8a3d,#e5631a);color:#fff;text-decoration:none;border-radius:8px;font-weight:800">予約詳細を開く</a>
    </p>
    ${isPending
      ? '<p style="font-size:.82rem;color:#3d556f;background:rgba(255,201,67,.1);padding:.7rem;border-radius:8px;border:1px solid rgba(255,201,67,.4);margin:0 0 1rem">当社にて内容を確認のうえ、あらためて確定通知をお送りします。</p>'
      : '<p style="font-size:.82rem;color:#3d556f;background:rgba(58,169,232,.08);padding:.7rem;border-radius:8px;border:1px solid #cae7f7;margin:0 0 1rem">当日は動きやすい服装（長袖・長ズボン・運動靴）でお越しください。ヘルメット・グローブは貸出可能です。</p>'}
    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:1.5rem 0 0;border-top:1px solid #d8e6f0;padding-top:1rem">
      福岡キッズカートアカデミー / エーワンサーキット<br>
      📞 <a href="tel:0929271177" style="color:#1a7fb8;text-decoration:none">092-927-1177</a> / 🌐 <a href="https://kidskart.org/" style="color:#1a7fb8;text-decoration:none">kidskart.org</a>
    </p>
  </div>
</body></html>`;

  const body: any = {
    from: `${fromName} <${from}>`,
    to: [args.to],
    subject,
    text,
    html,
  };
  if (replyTo) body.reply_to = replyTo;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${t.slice(0, 200)}`);
  }
}

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
