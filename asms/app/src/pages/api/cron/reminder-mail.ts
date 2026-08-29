import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { logCronRun } from '@lib/cron-log';

export const prerender = false;

// POST /api/cron/reminder-mail
//
// 前日 18:00 JST に GitHub Actions cron から叩かれる。
// 翌日の全予約に対して「明日はご参加お待ちしております」メールを保護者に送る。
// 二重送信防止のため reservations.reminder_email_sent_at を記録。
//
// 「開始後に送らない」ガード:
//   GitHub Actions cron はまれに数時間規模で遅延することがあり、日を
//   またぐと本来「明日」だった予約が「今日の午前中」になってしまう。
//   そのタイミングで送っても間に合うが、既に授業が開始した後には送らない
//   (start_time (JST) が現在時刻を過ぎたスロットはスキップ)。
//
// 対象日の範囲: today + 1 day を基本とするが、cron 遅延を吸収するため
//   date IN (today, tomorrow) で reminder_email_sent_at IS NULL 全てを送る。
//
// 認証: x-cron-secret ヘッダで env.CRON_SECRET と一致確認。

type CourseKind = 'taiken' | 'repeat' | 'challenge' | 'other';

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);

  // --- Auth ---------------------------------------------------------------
  const providedSecret = request.headers.get('x-cron-secret') ?? '';
  const expectedSecret = env.CRON_SECRET ?? '';
  if (!expectedSecret) {
    return json({ error: 'CRON_SECRET not configured on server' }, 500);
  }
  if (providedSecret !== expectedSecret) {
    return json({ error: 'unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin(env);

  try {
    const result = await logCronRun(supabase, 'reminder-mail', async () => {
  const urlObj = new URL(request.url);
  const dateOverride = urlObj.searchParams.get('date');

  const todayJst = todayInJst();
  const tomorrowJst = addDaysJst(todayJst, 1);

  // --- Fetch target slots ------------------------------------------------
  // dateOverride があればその 1 日、なければ today + tomorrow の 2 日
  const dateList = dateOverride ? [dateOverride] : [todayJst, tomorrowJst];
  const { data: rawSlots, error: slotsErr } = await supabase
    .from('slots')
    .select('id, date, start_time, end_time, courses(code, name)')
    .in('date', dateList)
    .neq('status', 'cancelled');
  if (slotsErr) {
    throw new Error(`failed to fetch slots: ${slotsErr.message}`);
  }

  // 開始時刻を過ぎていないスロットのみ (授業開始後には送らない)
  const slots = dateOverride
    ? (rawSlots ?? [])
    : (rawSlots ?? []).filter((s: any) => isBeforeStartJst(s.date, s.start_time));

  const slotIds = slots.map((s: any) => s.id);
  if (slotIds.length === 0) {
    return { dates: dateList, total: 0, sent: 0, note: 'no upcoming slots' };
  }

  const slotInfoById = new Map<string, {
    date: string;
    startTime: string;
    courseCode: string;
    courseName: string;
  }>();
  for (const s of slots as any[]) {
    slotInfoById.set(s.id, {
      date: s.date,
      startTime: s.start_time,
      courseCode: s.courses?.code ?? '',
      courseName: s.courses?.name ?? '',
    });
  }

  // --- Fetch reservations (confirmed + not yet reminder-sent) -----------
  const { data: reservations, error: rErr } = await supabase
    .from('reservations')
    .select(`
      id, slot_id, status, reminder_email_sent_at,
      guardians(id, name, email),
      reservation_participants(id, name_snapshot, attendance_status)
    `)
    .in('slot_id', slotIds)
    .eq('status', 'confirmed')
    .is('reminder_email_sent_at', null);
  if (rErr) {
    throw new Error(`failed to fetch reservations: ${rErr.message}`);
  }

  const total = (reservations ?? []).length;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ id: string; result: string; note?: string }> = [];

  for (const r of (reservations ?? []) as any[]) {
    try {
      const guardian = r.guardians;
      if (!guardian?.email) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no guardian email' });
        continue;
      }
      const slotInfo = slotInfoById.get(r.slot_id);
      if (!slotInfo) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'slot info missing' });
        continue;
      }
      const activeParticipants = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled'
      );
      if (activeParticipants.length === 0) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no active participants' });
        continue;
      }

      const isTomorrow = slotInfo.date === tomorrowJst;
      const dayLabel = isTomorrow ? '明日' : '本日';
      const courseKind = classifyCourse(slotInfo.courseCode);

      await sendReminderEmail(env, {
        to: guardian.email,
        guardianName: guardian.name,
        courseName: slotInfo.courseName,
        courseKind,
        slotDate: slotInfo.date,
        startTime: slotInfo.startTime,
        participantNames: activeParticipants.map((p: any) => p.name_snapshot),
        dayLabel,
      });

      const { error: updErr } = await supabase
        .from('reservations')
        .update({ reminder_email_sent_at: new Date().toISOString() })
        .eq('id', r.id);
      if (updErr) {
        console.warn('[reminder-mail] failed to mark sent for', r.id, updErr.message);
      }
      sent++;
      details.push({ id: r.id, result: 'sent', note: dayLabel });
    } catch (e: any) {
      failed++;
      details.push({ id: r.id, result: 'failed', note: e?.message ?? String(e) });
      console.warn('[reminder-mail] failed for', r.id, e);
    }
  }

      return { dates: dateList, total, sent, skipped, failed, details };
    });
    return json({ ok: true, ...result });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
};

// Also allow GET for easy manual testing (still requires secret)
export const GET = POST;

// --- Helpers ---------------------------------------------------------------

function todayInJst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDaysJst(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  // JST 00:00 の絶対時刻を Date.UTC(-9h) で作ってから加算
  const base = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
  const next = new Date(base + days * 86400 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(next);
}

function isBeforeStartJst(date: string, startTime: string | null): boolean {
  const startMs = jstDateTimeToUtcMs(date, startTime);
  if (startMs == null) return true; // 判定不能なら送る側 (安全に倒すか送らない側かは要検討、リマインドは送る)
  return Date.now() < startMs;
}

function jstDateTimeToUtcMs(date: string, time: string | null): number | null {
  if (!date || !time) return null;
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dm || !tm) return null;
  const y = parseInt(dm[1], 10);
  const mo = parseInt(dm[2], 10) - 1;
  const d = parseInt(dm[3], 10);
  const hh = parseInt(tm[1], 10);
  const mm = parseInt(tm[2], 10);
  const ss = tm[3] ? parseInt(tm[3], 10) : 0;
  return Date.UTC(y, mo, d, hh - 9, mm, ss);
}

function classifyCourse(code: string): CourseKind {
  if (code === 'taiken') return 'taiken';
  if (code.startsWith('repeat_')) return 'repeat';
  if (code.startsWith('challenge_')) return 'challenge';
  return 'other';
}

/** 開始時刻 (HH:MM) から 15 分引いた受付開始時刻 */
function checkInLabel(startTime: string): string {
  const [h, m] = startTime.split(':').map(Number);
  let total = h * 60 + m - 15;
  if (total < 0) total = 0;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][dt.getUTCDay()];
  return `${y}年${m}月${d}日 (${weekday})`;
}

async function sendReminderEmail(env: Env, args: {
  to: string;
  guardianName: string;
  courseName: string;
  courseKind: CourseKind;
  slotDate: string;
  startTime: string;
  participantNames: string[];
  dayLabel: string; // 「明日」or「本日」
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[reminder-mail] SKIP send: RESEND_API_KEY not set');
    return;
  }

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';
  const replyTo = env.MAIL_REPLY_TO || undefined;

  const dateLabel = formatDateLabel(args.slotDate);
  const startShort = args.startTime.slice(0, 5); // "HH:MM"
  const checkIn = checkInLabel(args.startTime);
  const subject = `${args.dayLabel}はご参加をお待ちしております — ${args.courseName}`;

  // 体験教室は「軍手初回プレゼント」なので持ち物リストから軍手を除く。
  // それ以外 (リピート / チャレンジ) は保護者に持参をお願い。
  const needsGloves = args.courseKind !== 'taiken';
  const itemsText = needsGloves
    ? '運動靴・軍手 (またはグローブ)'
    : '運動靴のみ';
  const itemsHtmlLines = [
    '<li><strong>運動靴</strong></li>',
    ...(needsGloves
      ? ['<li><strong>軍手 または グローブ</strong></li>']
      : []),
    '<li>つなぎ・ヘルメットは当校で無料貸出します</li>',
    ...(args.courseKind === 'taiken'
      ? ['<li>軍手は初回参加者にプレゼント (2 回目以降ご持参)</li>']
      : []),
  ].join('');

  const text = [
    `${args.guardianName} 様`,
    '',
    `${args.dayLabel} ${dateLabel} は福岡キッズカートアカデミーへのご来校、`,
    'お待ちしております。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `▼ ご予約内容`,
    '━━━━━━━━━━━━━━━━━━━━',
    `コース: ${args.courseName}`,
    `開始時刻: ${startShort}`,
    `受付開始: ${checkIn} (開始 15 分前)`,
    `参加者: ${args.participantNames.join(' / ')}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ 持ち物',
    '━━━━━━━━━━━━━━━━━━━━',
    `  ${itemsText}`,
    '  ※つなぎ・ヘルメットは当校で無料貸出',
    ...(args.courseKind === 'taiken' ? ['  ※軍手は初回参加者にプレゼント'] : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ アクセス',
    '━━━━━━━━━━━━━━━━━━━━',
    'エーワンサーキット (福岡県筑紫野市大字原田1338)',
    'https://kidskart.org/#access',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ キャンセルについて',
    '━━━━━━━━━━━━━━━━━━━━',
    '開始 2 時間前まで無料でキャンセル可能です。',
    '天候・体調不良等ある場合は下記までご連絡ください。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '✉️ info@kidskart.org',
    '📞 092-927-1177',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🏁</div>
    <h2 style="text-align:center;margin:0 0 .5rem;font-size:1.15rem">${escapeHtml(args.dayLabel)}はご参加をお待ちしております！</h2>
    <p style="text-align:center;margin:0 0 1.2rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>

    <div style="background:rgba(58,169,232,.08);border:1px solid #cae7f7;border-radius:10px;padding:1rem;margin:1rem 0">
      <div style="font-weight:800;color:#1a7fb8;font-size:.85rem;margin-bottom:.5rem">ご予約内容</div>
      <div style="font-size:.9rem;line-height:1.9">
        <div><strong>${escapeHtml(dateLabel)}</strong></div>
        <div>コース: <strong>${escapeHtml(args.courseName)}</strong></div>
        <div>開始時刻: <strong>${escapeHtml(startShort)}</strong></div>
        <div style="color:#e5631a;font-weight:700">受付開始: ${escapeHtml(checkIn)} (開始 15 分前)</div>
        <div style="margin-top:.4rem">参加者: ${escapeHtml(args.participantNames.join(' / '))}</div>
      </div>
    </div>

    <div style="background:rgba(255,201,67,.08);border-top:2px solid #ffc943;border-bottom:2px solid #ffc943;padding:.7rem 1rem;margin:1rem 0">
      <div style="font-weight:800;color:#e5631a;font-size:.9rem;margin-bottom:.5rem">🎒 持ち物</div>
      <ul style="font-size:.85rem;line-height:1.8;margin:0;padding-left:1.3rem">
        ${itemsHtmlLines}
      </ul>
    </div>

    <div style="background:#f4f9fc;border-radius:8px;padding:.8rem 1rem;margin:1rem 0;font-size:.83rem;color:#3d556f">
      <div style="font-weight:700;margin-bottom:.3rem">📍 アクセス</div>
      エーワンサーキット (福岡県筑紫野市大字原田1338)<br>
      <a href="https://kidskart.org/#access" style="color:#1a7fb8;text-decoration:none">▶ 地図・行き方はこちら</a>
    </div>

    <div style="background:#f4f9fc;border-radius:8px;padding:.8rem 1rem;margin:1rem 0;font-size:.83rem;color:#3d556f">
      <div style="font-weight:700;margin-bottom:.3rem">🌦 キャンセル・天候について</div>
      開始 2 時間前までのキャンセルは無料です。<br>
      体調不良・天候ご心配等あれば早めにご連絡ください。
    </div>

    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:1.5rem 0 0;border-top:1px solid #d8e6f0;padding-top:1rem">
      福岡キッズカートアカデミー / エーワンサーキット<br>
      ✉️ <a href="mailto:info@kidskart.org" style="color:#1a7fb8;text-decoration:none">info@kidskart.org</a> / 📞 <a href="tel:0929271177" style="color:#1a7fb8;text-decoration:none">092-927-1177</a>
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
