import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/reserve/cancel
//
// Cancel a reservation using the URL-safe cancel_token that was
// generated at booking time and embedded in the confirmation email.
// The token is the sole auth — knowing the URL = right to cancel.
// 32 URL-safe base64 chars = 192 bits of entropy, so guessing is
// infeasible.
//
// Body:
//   { token: string, reason?: string }                       — whole-reservation cancel
//   { token, reason?, participant_ids: string[] }            — partial cancel of listed participants
//     (if participant_ids equals the full set → treated as whole cancel;
//      if it leaves ≥1 active → partial with recalc + email;
//      if empty → whole cancel for backwards compat)
// Response: { ok: true, reservation_number, cancelled_at, partial? }
//          | { error: string, hint?: string }

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }

  const token = (body?.token ?? '').trim();
  const reason = (body?.reason ?? 'お客様都合（Web からキャンセル）').trim();
  const requestedPartIds: string[] = Array.isArray(body?.participant_ids)
    ? body.participant_ids.filter((s: any) => typeof s === 'string')
    : [];
  if (!token || token.length < 20) {
    return json({ error: 'キャンセルトークンが不正です', hint: 'bad_token' }, 400);
  }

  // Load reservation + related for email context
  const { data: res, error: rErr } = await supabase
    .from('reservations')
    .select(`
      id, reservation_number, status, price_tier, total_amount, cancel_token,
      slot_id,
      slots(date, start_time, end_time, courses(name, price_regular, price_member)),
      guardians(name, email, phone),
      reservation_participants(id, name_snapshot, attendance_status)
    `)
    .eq('cancel_token', token)
    .maybeSingle();

  if (rErr) return json({ error: `検索エラー: ${rErr.message}` }, 500);
  if (!res) return json({ error: '該当予約が見つかりません', hint: 'not_found' }, 404);

  if (res.status === 'cancelled') {
    return json({
      ok: true,
      already: true,
      reservation_number: res.reservation_number,
    });
  }
  if (res.status === 'attended' || res.status === 'no_show') {
    return json({
      error: `この予約は既に「${res.status === 'attended' ? '出席済み' : '無断欠席'}」として記録されています。キャンセルできません。`,
      hint: 'terminal_status',
    }, 409);
  }

  // Decide: partial or whole?
  const allParts = (res.reservation_participants ?? []) as any[];
  const currentlyActive = allParts.filter((p) => p.attendance_status !== 'cancelled');
  const activeIdSet = new Set(currentlyActive.map((p) => p.id));
  const requestedActive = requestedPartIds.filter((id) => activeIdSet.has(id));

  const isPartial =
    requestedActive.length > 0 &&
    requestedActive.length < currentlyActive.length;

  const cancelledAt = new Date().toISOString();

  // ---------- Partial cancel path ----------
  if (isPartial) {
    // 1) Mark selected participants as cancelled
    const { error: pErr } = await supabase
      .from('reservation_participants')
      .update({ attendance_status: 'cancelled' })
      .in('id', requestedActive);
    if (pErr) return json({ error: `参加者更新に失敗: ${pErr.message}` }, 500);

    // 2) Recalculate total_amount
    const remaining = currentlyActive.filter((p) => !requestedActive.includes(p.id));
    const perPerson = res.price_tier === 'member'
      ? ((res.slots as any)?.courses?.price_member ?? 0)
      : ((res.slots as any)?.courses?.price_regular ?? 0);
    const newTotal = remaining.length * perPerson;

    const { error: rrErr } = await supabase
      .from('reservations')
      .update({ total_amount: newTotal })
      .eq('id', res.id);
    if (rrErr) return json({ error: `料金再計算に失敗: ${rrErr.message}` }, 500);

    // 3) Emails
    const apiUrl = new URL(request.url);
    const origin = `${apiUrl.protocol}//${apiUrl.host}`;
    const slot: any = res.slots ?? {};
    const course: any = slot.courses ?? {};
    const guardian: any = res.guardians ?? {};
    const cancelledNames = allParts
      .filter((p) => requestedActive.includes(p.id))
      .map((p) => p.name_snapshot);
    const remainingNames = remaining.map((p) => p.name_snapshot);

    const guardianEmailP = sendPartialCancellationEmailToGuardian(env, {
      to: guardian.email ?? '',
      guardianName: guardian.name ?? '',
      reservationNumber: res.reservation_number,
      dateIso: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
      courseName: course.name ?? '',
      cancelledNames,
      remainingNames,
      newTotal,
      priceTier: res.price_tier ?? 'regular',
      origin,
      reason,
    }).catch((e) => console.warn('[reserve/cancel] partial guardian email failed:', e));

    const adminEmailP = sendCancellationEmailToAdmin(env, {
      to: env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO || '',
      reservationNumber: res.reservation_number,
      dateIso: slot.date,
      startTime: slot.start_time,
      endTime: slot.end_time,
      courseName: course.name ?? '',
      guardianName: guardian.name ?? '',
      guardianPhone: guardian.phone ?? '',
      guardianEmail: guardian.email ?? '',
      participants: cancelledNames, // 一部キャンセル分だけ
      reason: `[一部キャンセル] ${reason} / 残り: ${remainingNames.join('・')} (${remainingNames.length}名) ¥${newTotal.toLocaleString()}`,
      origin,
      slotId: res.slot_id,
      reservationId: res.id,
    }).catch((e) => console.warn('[reserve/cancel] admin email failed:', e));

    const runtimeCtx = (locals as any).runtime?.ctx;
    if (runtimeCtx?.waitUntil) {
      runtimeCtx.waitUntil(guardianEmailP);
      runtimeCtx.waitUntil(adminEmailP);
    }

    return json({
      ok: true,
      partial: true,
      reservation_number: res.reservation_number,
      cancelled_at: cancelledAt,
      remaining_count: remaining.length,
      new_total: newTotal,
    });
  }

  // ---------- Whole cancel path (existing behavior) ----------
  const { error: uErr } = await supabase
    .from('reservations')
    .update({
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancelled_reason: reason,
    })
    .eq('id', res.id);
  if (uErr) return json({ error: `キャンセル更新に失敗: ${uErr.message}` }, 500);

  // Fire-and-forget emails
  const apiUrl = new URL(request.url);
  const origin = `${apiUrl.protocol}//${apiUrl.host}`;
  const slot: any = res.slots ?? {};
  const course: any = slot.courses ?? {};
  const guardian: any = res.guardians ?? {};
  const parts = allParts.map((p) => p.name_snapshot);

  const guardianEmailP = sendCancellationEmailToGuardian(env, {
    to: guardian.email ?? '',
    guardianName: guardian.name ?? '',
    reservationNumber: res.reservation_number,
    dateIso: slot.date,
    startTime: slot.start_time,
    endTime: slot.end_time,
    courseName: course.name ?? '',
    participants: parts,
    totalAmount: res.total_amount ?? 0,
    priceTier: res.price_tier ?? 'regular',
    origin,
    cancelledAt,
    reason,
  }).catch((e) => console.warn('[reserve/cancel] guardian email failed:', e));

  const adminEmailP = sendCancellationEmailToAdmin(env, {
    to: env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO || '',
    reservationNumber: res.reservation_number,
    dateIso: slot.date,
    startTime: slot.start_time,
    endTime: slot.end_time,
    courseName: course.name ?? '',
    guardianName: guardian.name ?? '',
    guardianPhone: guardian.phone ?? '',
    guardianEmail: guardian.email ?? '',
    participants: parts,
    reason,
    origin,
    slotId: res.slot_id,
    reservationId: res.id,
  }).catch((e) => console.warn('[reserve/cancel] admin email failed:', e));

  const runtimeCtx = (locals as any).runtime?.ctx;
  if (runtimeCtx && typeof runtimeCtx.waitUntil === 'function') {
    runtimeCtx.waitUntil(guardianEmailP);
    runtimeCtx.waitUntil(adminEmailP);
  }

  return json({
    ok: true,
    reservation_number: res.reservation_number,
    cancelled_at: cancelledAt,
  });
};

// Fire-and-forget: notify the guardian that they cancelled a subset of
// participants (partial cancel). Shows who's out, who's staying, and
// the new total.
async function sendPartialCancellationEmailToGuardian(env: Env, args: {
  to: string;
  guardianName: string;
  reservationNumber: string;
  dateIso: string;
  startTime: string;
  endTime: string | null;
  courseName: string;
  cancelledNames: string[];
  remainingNames: string[];
  newTotal: number;
  priceTier: string;
  origin: string;
  reason: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !args.to) return;
  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';

  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(args.dateIso + 'T00:00:00');
  const dateLabel = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJa[d.getDay()]})`;
  const timeLabel = `${args.startTime.slice(0, 5)}${args.endTime ? '–' + args.endTime.slice(0, 5) : ''}`;
  const cancelledLabel = args.cancelledNames.join('・');
  const remainingLabel = args.remainingNames.join('・');
  const subject = `【一部キャンセル承りました】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName}`;

  const yenNew = `¥${args.newTotal.toLocaleString('ja-JP')}`;

  const text = [
    `${args.guardianName} 様`,
    '',
    `${cancelledLabel} さんの参加キャンセルを承りました。`,
    `残り ${args.remainingNames.length} 名 (${remainingLabel}) は予約継続中です。`,
    '',
    `▼ 予約情報`,
    `予約番号: ${args.reservationNumber}`,
    `コース  : ${args.courseName}`,
    `日時   : ${dateLabel} ${timeLabel}`,
    `キャンセル: ${cancelledLabel}`,
    `残り参加: ${remainingLabel} (${args.remainingNames.length}名)`,
    `新しい合計: ${yenNew} (${args.priceTier === 'member' ? '会員' : '一般'} × ${args.remainingNames.length}名)`,
    '',
    `キャンセル理由: ${args.reason}`,
    '',
    'キャンセル料が発生する場合は別途ご連絡いたします。',
    'ご不明な点は 092-927-1177 までお問い合わせください。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '📞 092-927-1177',
    '🌐 https://kidskart.org/',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">✅</div>
    <h2 style="text-align:center;margin:0 0 .4rem;font-size:1.1rem;color:#1a7fb8">一部キャンセル承りました</h2>
    <p style="text-align:center;margin:0 0 1rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>
    <p style="font-size:.86rem;color:#163048;margin:0 0 1rem"><strong>${escapeHtml(cancelledLabel)}</strong> さんの参加キャンセルを承りました。<br>残り ${args.remainingNames.length} 名は予約継続中です。</p>
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;margin-bottom:1rem">
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700">予約番号</td><td style="padding:.4rem 0;text-align:right;font-family:monospace">${escapeHtml(args.reservationNumber)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">コース</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0">${escapeHtml(args.courseName)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">日時</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;border-top:1px dashed #d8e6f0">${escapeHtml(dateLabel)} ${escapeHtml(timeLabel)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#c73854;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">キャンセル</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0;color:#c73854">${escapeHtml(cancelledLabel)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">残り参加</td><td style="padding:.4rem 0;text-align:right;border-top:1px dashed #d8e6f0">${escapeHtml(remainingLabel)} <span style="color:#7d8fa0">(${args.remainingNames.length}名)</span></td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">新しい合計</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;font-weight:800;border-top:1px dashed #d8e6f0">${escapeHtml(yenNew)}</td></tr>
    </table>
    <p style="font-size:.82rem;color:#3d556f;background:#f4f9fc;padding:.7rem;border-radius:8px;border:1px solid #d8e6f0;margin:0 0 1rem"><strong>キャンセル理由</strong><br>${escapeHtml(args.reason)}</p>
    <p style="font-size:.78rem;color:#7d8fa0;margin:0 0 1rem">※ キャンセル料が発生する場合は別途ご連絡いたします。</p>
    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:1.5rem 0 0;border-top:1px solid #d8e6f0;padding-top:1rem">
      福岡キッズカートアカデミー / エーワンサーキット<br>
      📞 <a href="tel:0929271177" style="color:#1a7fb8;text-decoration:none">092-927-1177</a> / 🌐 <a href="https://kidskart.org/" style="color:#1a7fb8;text-decoration:none">kidskart.org</a>
    </p>
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
      reply_to: env.MAIL_REPLY_TO || undefined,
    }),
  });
  if (!r.ok) throw new Error(`Resend partial-cancel ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendCancellationEmailToGuardian(env: Env, args: {
  to: string;
  guardianName: string;
  reservationNumber: string;
  dateIso: string;
  startTime: string;
  endTime: string | null;
  courseName: string;
  participants: string[];
  totalAmount: number;
  priceTier: string;
  origin: string;
  cancelledAt: string;
  reason: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !args.to) return;
  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';

  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(args.dateIso + 'T00:00:00');
  const dateLabel = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJa[d.getDay()]})`;
  const timeLabel = `${args.startTime.slice(0, 5)}${args.endTime ? '–' + args.endTime.slice(0, 5) : ''}`;
  const subject = `【キャンセル完了】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName} — ${args.reservationNumber}`;

  const text = [
    `${args.guardianName} 様`,
    '',
    'ご予約のキャンセルを承りました。',
    '',
    `▼ キャンセルされた予約`,
    `予約番号: ${args.reservationNumber}`,
    `コース  : ${args.courseName}`,
    `日時   : ${dateLabel} ${timeLabel}`,
    `参加者  : ${args.participants.join('・')} (${args.participants.length}名)`,
    `料金   : ¥${args.totalAmount.toLocaleString()} (${args.priceTier === 'member' ? '会員' : '一般'})`,
    '',
    `キャンセル理由: ${args.reason}`,
    '',
    '▼ キャンセルポリシー（参考）',
    '- 前日 20:00 まで: キャンセル料なし',
    '- 前日 20:00 以降 〜 開始 2 時間前: キャンセル料 50%',
    '- 開始 2 時間前以降 / 無連絡不参加: キャンセル料 100%',
    '- 天候由来の当社判断による中止: キャンセル料なし',
    '',
    'キャンセル料の請求が発生する場合は別途ご連絡いたします。',
    'また改めてのご予約をお待ちしております。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '📞 092-927-1177',
    '🌐 https://kidskart.org/',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🚫</div>
    <h2 style="text-align:center;margin:0 0 .4rem;font-size:1.1rem">ご予約のキャンセルを承りました</h2>
    <p style="text-align:center;margin:0 0 1rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;margin-bottom:1rem">
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700">予約番号</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;color:#7d8fa0;text-decoration:line-through">${escapeHtml(args.reservationNumber)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">コース</td><td style="padding:.4rem 0;text-align:right;color:#7d8fa0;border-top:1px dashed #d8e6f0">${escapeHtml(args.courseName)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">日時</td><td style="padding:.4rem 0;text-align:right;font-family:monospace;color:#7d8fa0;border-top:1px dashed #d8e6f0">${escapeHtml(dateLabel)} ${escapeHtml(timeLabel)}</td></tr>
      <tr><td style="padding:.4rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">参加者</td><td style="padding:.4rem 0;text-align:right;color:#7d8fa0;border-top:1px dashed #d8e6f0">${escapeHtml(args.participants.join('・'))} (${args.participants.length}名)</td></tr>
    </table>
    <p style="font-size:.82rem;color:#3d556f;background:rgba(255,201,67,.1);padding:.7rem;border-radius:8px;border:1px solid rgba(255,201,67,.4);margin:0 0 1rem;line-height:1.7">
      <strong style="color:#e5631a">キャンセルポリシー（参考）</strong><br>
      前日 20:00 まで: キャンセル料なし<br>
      前日 20:00 以降 〜 開始 2 時間前: キャンセル料 50%<br>
      開始 2 時間前以降 / 無連絡不参加: キャンセル料 100%<br>
      キャンセル料の請求がある場合は別途ご連絡いたします。
    </p>
    <p style="text-align:center;margin:1rem 0 0;font-size:.86rem;color:#3d556f">また改めてのご予約をお待ちしております。</p>
    <p style="text-align:center;margin:1.5rem 0 0">
      <a href="${args.origin}/reserve/" style="display:inline-block;padding:.7rem 1.4rem;background:linear-gradient(135deg,#ff8a3d,#e5631a);color:#fff;text-decoration:none;border-radius:8px;font-weight:800">別の日程を予約する</a>
    </p>
    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:1.5rem 0 0;border-top:1px solid #d8e6f0;padding-top:1rem">
      福岡キッズカートアカデミー / エーワンサーキット<br>
      📞 <a href="tel:0929271177" style="color:#1a7fb8;text-decoration:none">092-927-1177</a> / 🌐 <a href="https://kidskart.org/" style="color:#1a7fb8;text-decoration:none">kidskart.org</a>
    </p>
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
      reply_to: env.MAIL_REPLY_TO || undefined,
    }),
  });
  if (!r.ok) throw new Error(`Resend cancel-guardian ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sendCancellationEmailToAdmin(env: Env, args: {
  to: string;
  reservationNumber: string;
  dateIso: string;
  startTime: string;
  endTime: string | null;
  courseName: string;
  guardianName: string;
  guardianPhone: string;
  guardianEmail: string;
  participants: string[];
  reason: string;
  origin: string;
  slotId: string;
  reservationId: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !args.to) return;
  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';

  const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
  const d = new Date(args.dateIso + 'T00:00:00');
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()} (${weekdayJa[d.getDay()]})`;
  const timeLabel = `${args.startTime.slice(0, 5)}${args.endTime ? '–' + args.endTime.slice(0, 5) : ''}`;
  const subject = `【予約キャンセル】${dateLabel} ${args.startTime.slice(0, 5)} ${args.courseName} ${args.guardianName}様`;

  const slotUrl = `${args.origin}/admin/slots/${args.slotId}`;
  const resUrl = `${args.origin}/reserve/complete/${args.reservationId}`;

  const text = [
    '予約がキャンセルされました。',
    '',
    `予約番号: ${args.reservationNumber}`,
    `コース  : ${args.courseName}`,
    `日時   : ${dateLabel} ${timeLabel}`,
    `参加者  : ${args.participants.join('・')} (${args.participants.length}名)`,
    `保護者  : ${args.guardianName} / ${args.guardianPhone} / ${args.guardianEmail}`,
    `理由   : ${args.reason}`,
    '',
    `▼ スロット詳細`,
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
    <h2 style="margin:0 0 .8rem;font-size:1.1rem;color:#c73854">🚫 予約がキャンセルされました</h2>
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;margin-bottom:1rem">
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;width:5.5em">予約番号</td><td style="padding:.35rem 0;font-family:monospace;color:#7d8fa0;text-decoration:line-through">${escapeHtml(args.reservationNumber)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">コース</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">${escapeHtml(args.courseName)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">日時</td><td style="padding:.35rem 0;font-family:monospace;border-top:1px dashed #d8e6f0">${escapeHtml(dateLabel)} ${escapeHtml(timeLabel)}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">参加者</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">${escapeHtml(args.participants.join('・'))}</td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0;vertical-align:top">保護者</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">
        ${escapeHtml(args.guardianName)}<br>
        <span style="font-family:monospace;font-size:.76rem">📞 ${escapeHtml(args.guardianPhone)}</span><br>
        <span style="font-family:monospace;font-size:.76rem">✉️ ${escapeHtml(args.guardianEmail)}</span>
      </td></tr>
      <tr><td style="padding:.35rem 0;color:#7d8fa0;font-size:.72rem;font-weight:700;border-top:1px dashed #d8e6f0">理由</td><td style="padding:.35rem 0;border-top:1px dashed #d8e6f0">${escapeHtml(args.reason)}</td></tr>
    </table>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem">
      <a href="${slotUrl}" style="flex:1;padding:.6rem 1rem;background:#3aa9e8;color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.84rem;text-align:center">📋 スロット詳細</a>
      <a href="${resUrl}" style="flex:1;padding:.6rem 1rem;background:#f4f9fc;color:#163048;border:1px solid #d8e6f0;text-decoration:none;border-radius:6px;font-weight:700;font-size:.84rem;text-align:center">予約詳細</a>
    </div>
    <p style="margin:1rem 0 0;padding:.6rem;background:rgba(255,201,67,.1);border:1px solid rgba(255,201,67,.4);border-radius:6px;font-size:.78rem">
      キャンセル料の判定・徴収が必要な場合はキャンセルポリシーに沿って対応してください。
    </p>
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
  if (!r.ok) throw new Error(`Resend cancel-admin ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
