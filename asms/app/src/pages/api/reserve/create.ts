import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/reserve/create
//
// Thin wrapper around create_reservation_atomic() PL/pgSQL function.
// The heavy lifting (SELECT FOR UPDATE slot lock, capacity check,
// guardian/customer dedup, all INSERTs) happens in one Postgres
// transaction on the DB side — TOCTOU-safe and orphan-free.
// This handler just validates the request, calls the RPC, maps its
// error code back to HTTP, and fires the notification emails.
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

  // --- Shallow validation (defence in depth; wizard is the real filter) --
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
  for (const p of participants) {
    if (!p.name || !p.kana || !p.birth_date || !p.gender || !p.height_cm) {
      return json({ error: '参加者情報に不足があります' }, 400);
    }
  }

  const guardianEmail = (guardian.email ?? '').trim();

  // --- Single atomic RPC call --------------------------------------------
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('create_reservation_atomic', {
    payload: {
      slot_id,
      term_id,
      price_tier: price_tier === 'member' ? 'member' : 'regular',
      guardian: { ...guardian, email: guardianEmail },
      emergency,
      participants,
      signature,
      checked_safety_items,
      ip_address: request.headers.get('CF-Connecting-IP') || clientAddress || '',
      user_agent: request.headers.get('User-Agent') || '',
    },
  });

  if (rpcErr) {
    // Custom SQLSTATE 'PGRSN' → domain error. Map to appropriate HTTP.
    const hint = rpcErr.hint ?? '';
    const message = rpcErr.message ?? '不明なエラー';
    if (rpcErr.code === 'PGRSN') {
      const httpCode =
        hint === 'slot_not_found' ? 404 :
        hint === 'slot_not_open'  ? 409 :
        hint === 'slot_full'      ? 409 :
        hint === 'terms_not_found' ? 400 :
        hint === 'empty_participants' || hint === 'missing_field' ? 400 :
        500;
      return json({ error: message, hint }, httpCode);
    }
    // Unexpected Postgres error
    return json({
      error: `予約の登録に失敗しました: ${message}`,
      detail: `${rpcErr.code ?? ''} ${rpcErr.details ?? ''} ${rpcErr.hint ?? ''}`.trim(),
    }, 500);
  }

  const result: any = rpcResult ?? {};
  if (!result.ok) {
    return json({ error: '予約作成が失敗しました', detail: JSON.stringify(result) }, 500);
  }

  // --- Fire-and-forget notification emails -------------------------------
  // Wrapped in ctx.waitUntil so Cloudflare Workers keeps the async fetch
  // alive after we return the response.
  const apiUrl = new URL(request.url);
  const emailPromise = sendConfirmationEmail(env, {
    to: guardianEmail,
    guardianName: guardian.name,
    reservationNumber: result.reservation_number,
    status: result.status,
    dateIso: result.slot_date,
    startTime: result.slot_start_time,
    endTime: result.slot_end_time,
    courseName: result.course_name,
    participants: participants.map((p: any) => p.name),
    totalAmount: result.total_amount,
    priceTier: price_tier,
    origin: `${apiUrl.protocol}//${apiUrl.host}`,
    reservationId: result.reservation_id,
    cancelToken: result.cancel_token,
  }).catch((e) => console.warn('[reserve/create] email send failed:', e));

  const adminEmailPromise = sendAdminNotification(env, {
    to: env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO || '',
    reservationNumber: result.reservation_number,
    status: result.status,
    dateIso: result.slot_date,
    startTime: result.slot_start_time,
    endTime: result.slot_end_time,
    courseName: result.course_name,
    guardianName: guardian.name,
    guardianPhone: guardian.phone,
    guardianEmail: guardianEmail,
    participants: participants.map((p: any) => ({ name: p.name, birth_date: p.birth_date, height_cm: p.height_cm })),
    totalAmount: result.total_amount,
    priceTier: price_tier,
    origin: `${apiUrl.protocol}//${apiUrl.host}`,
    reservationId: result.reservation_id,
    slotId: slot_id,
  }).catch((e) => console.warn('[reserve/create] admin email send failed:', e));

  const runtimeCtx = (locals as any).runtime?.ctx;
  if (runtimeCtx && typeof runtimeCtx.waitUntil === 'function') {
    runtimeCtx.waitUntil(emailPromise);
    runtimeCtx.waitUntil(adminEmailPromise);
  } else {
    console.warn('[reserve/create] no runtime.ctx.waitUntil — email may be cancelled after response');
  }

  return json({
    ok: true,
    reservation_id: result.reservation_id,
    reservation_number: result.reservation_number,
    status: result.status,
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
  cancelToken?: string;
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
  const cancelUrl = args.cancelToken ? `${args.origin}/reserve/cancel/${args.cancelToken}` : '';

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
    ...(cancelUrl ? [`▼ キャンセルはこちら`, cancelUrl, ''] : []),
    isPending
      ? '当社確認のうえ、あらためて確定通知をお送りします。'
      : '当日は運動靴でお越しください。つなぎ・ヘルメットは当社で無料貸出します（長袖長ズボン不要）。軍手は初回のみプレゼント、2 回目以降はご持参をお願いします。',
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
    ${cancelUrl ? `<p style="text-align:center;margin:.5rem 0 1rem;font-size:.78rem"><a href="${cancelUrl}" style="color:#c73854;text-decoration:none;font-weight:700">🚫 予約をキャンセルする</a></p>` : ''}
    ${isPending
      ? '<p style="font-size:.82rem;color:#3d556f;background:rgba(255,201,67,.1);padding:.7rem;border-radius:8px;border:1px solid rgba(255,201,67,.4);margin:0 0 1rem">当社にて内容を確認のうえ、あらためて確定通知をお送りします。</p>'
      : '<div style="font-size:.82rem;color:#3d556f;background:rgba(58,169,232,.08);padding:.8rem;border-radius:8px;border:1px solid #cae7f7;margin:0 0 1rem;line-height:1.7"><strong style="color:#1a7fb8">当日の装備について</strong><ul style="margin:.5rem 0 0;padding-left:1.2rem"><li><strong>運動靴</strong>（ご持参ください）</li><li>つなぎ・ヘルメット: 当社で<strong>無料貸出</strong>（長袖長ズボン不要）</li><li>軍手: <strong>初回のみプレゼント</strong>、2 回目以降はご持参ください</li></ul></div>'}
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

async function sendAdminNotification(env: Env, args: {
  to: string;
  reservationNumber: string;
  status: string;
  dateIso: string;
  startTime: string;
  endTime: string | null;
  courseName: string;
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string;
  participants: Array<{ name: string; birth_date: string; height_cm: number }>;
  totalAmount: number;
  priceTier: string;
  origin: string;
  reservationId: string;
  slotId: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[admin-notif] SKIP: RESEND_API_KEY not set');
    return;
  }
  if (!args.to) {
    console.warn('[admin-notif] SKIP: MAIL_ADMIN_TO not set');
    return;
  }
  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';

  const isPending = args.status === 'pending_approval';
  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(args.dateIso + 'T00:00:00');
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()} (${weekdayJa[d.getDay()]})`;
  const timeLabel = `${args.startTime.slice(0, 5)}${args.endTime ? '–' + args.endTime.slice(0, 5) : ''}`;

  const subject = isPending
    ? `【承認待ち予約】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName} ${args.guardianName}様 (${args.participants.length}名)`
    : `【新規予約】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName} ${args.guardianName}様 (${args.participants.length}名)`;

  const partList = args.participants
    .map((p) => `${p.name}(${p.birth_date} · ${p.height_cm}cm)`)
    .join(' / ');

  const slotUrl = `${args.origin}/admin/slots/${args.slotId}`;
  const resUrl = `${args.origin}/reserve/complete/${args.reservationId}`;

  const text = [
    `新規予約が入りました${isPending ? '（承認待ち）' : ''}。`,
    '',
    `予約番号: ${args.reservationNumber}`,
    `コース  : ${args.courseName}`,
    `日時   : ${dateLabel} ${timeLabel}`,
    `参加者  : ${partList}`,
    `保護者  : ${args.guardianName} / ${args.guardianPhone} / ${args.guardianEmail}`,
    `料金   : ¥${args.totalAmount.toLocaleString()} (${args.priceTier === 'member' ? '会員' : '一般'})`,
    '',
    `▼ スロット詳細（当日運用）`,
    slotUrl,
    '',
    `▼ 予約詳細`,
    resUrl,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    'ASMS 自動通知',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Sans',sans-serif;color:#163048;margin:0;padding:1rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:1.2rem 1.3rem;border:1px solid #d8e6f0">
    <div style="font-size:.72rem;color:#7d8fa0;font-family:monospace;margin-bottom:.5rem">ASMS 自動通知</div>
    <h2 style="margin:0 0 .8rem;font-size:1.1rem;color:${isPending ? '#e5631a' : '#7eb13a'}">
      ${isPending ? '⏳ 承認待ち予約が入りました' : '✅ 新規予約が入りました'}
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;margin-bottom:1rem">
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;width:5.5em">予約番号</td><td style="padding:.35rem 0;font-family:monospace;color:#1a7fb8;font-weight:800">${escapeHtml(args.reservationNumber)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">コース</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">${escapeHtml(args.courseName)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">日時</td><td style="padding:.35rem 0;font-family:monospace;border-top:1px dashed #d8e6f0">${escapeHtml(dateLabel)} ${escapeHtml(timeLabel)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0;vertical-align:top">参加者</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">${escapeHtml(partList)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0;vertical-align:top">保護者</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">
        ${escapeHtml(args.guardianName)}<br>
        <span style="font-family:monospace;font-size:.76rem;color:#3d556f">📞 ${escapeHtml(args.guardianPhone)}</span><br>
        <span style="font-family:monospace;font-size:.76rem;color:#3d556f">✉️ ${escapeHtml(args.guardianEmail)}</span>
      </td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">料金</td><td style="padding:.35rem 0;font-family:monospace;color:#e5631a;font-weight:800;border-top:1px dashed #d8e6f0">¥${args.totalAmount.toLocaleString()} (${args.priceTier === 'member' ? '会員' : '一般'})</td></tr>
    </table>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem">
      <a href="${slotUrl}" style="flex:1;padding:.6rem 1rem;background:#3aa9e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.84rem;text-align:center">📋 スロット詳細（当日運用）</a>
      <a href="${resUrl}" style="flex:1;padding:.6rem 1rem;background:#f4f9fc;color:#163048;border:1px solid #d8e6f0;text-decoration:none;border-radius:6px;font-weight:700;font-size:.84rem;text-align:center">予約詳細</a>
    </div>
    ${isPending ? '<p style="margin:1rem 0 0;padding:.6rem;background:rgba(255,201,67,.15);border:1px solid rgba(255,201,67,.4);border-radius:6px;font-size:.78rem">承認制コースです。管理画面から確認 → 確定通知を保護者へお送りください。</p>' : ''}
  </div>
</body></html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [args.to],
      subject,
      text,
      html,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Resend admin-notif ${r.status}: ${t.slice(0, 200)}`);
  }
  console.log('[admin-notif] sent to', args.to);
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
