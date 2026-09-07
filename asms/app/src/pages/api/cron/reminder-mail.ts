import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { logCronRun } from '@lib/cron-log';

export const prerender = false;

// POST /api/cron/reminder-mail
//
// 前日 18:30 JST に Cloudflare Workers Cron から叩かれる。
// 翌日の全予約に対して「明日はご参加お待ちしております」メールを保護者に送る。
// 二重送信防止のため reservations.reminder_email_sent_at を記録。
//
// 「開始後に送らない」ガード:
//   Cron はまれに遅延することがあり、日をまたぐと本来「明日」だった予約
//   が「今日の午前中」になってしまう。そのタイミングで送っても間に合うが、
//   既に授業が開始した後には送らない (start_time (JST) が現在時刻を過ぎた
//   スロットはスキップ)。
//
// 対象日の範囲: today + 1 day を基本とするが、cron 遅延を吸収するため
//   date IN (today, tomorrow) で reminder_email_sent_at IS NULL 全てを送る。
//
// 送信単位: **(guardian, slot.date) 単位で 1 通** (2026-09-07 変更、シリーズ 3/3)。
// 同一保護者・同一開催日に複数予約があれば全予約分を 1 通に集約する。
// 予約 (コース) ごとにセクション分けし、それぞれ開始時刻・受付開始時刻・
// 参加者リストを表示。持ち物欄は group 内のコース種別を集約して判定
// (taiken なら軍手初回プレゼント、非 taiken 混在なら軍手/グローブ持参必須)。
// DB flag (reminder_email_sent_at) は従来通り予約単位で持ち、送信成功時は
// group 内全予約を 1 UPDATE で同時セット (atomic)。
// Resend Idempotency-Key: "reminder:<date>:<guardianId>" で二重送信防止
// (DB 更新失敗時のリカバリ safety net、24h 保持)。
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
  // flag UPDATE 失敗を貯める配列 (メール送信成功後の DB flag update 失敗)。
  // ループ完了後に配列が空でなければ throw して cron 全体を error 扱いに。
  const flagUpdateErrors: Array<{ groupIds: string[]; error: string }> = [];

  // 同一保護者・同一開催日の複数予約を 1 通に集約する。
  // key format: "<guardianId>|<slot.date>"
  const groupsByGuardianDate = new Map<string, any[]>();
  const orphaned: any[] = [];
  for (const r of (reservations ?? []) as any[]) {
    const slotInfo = slotInfoById.get(r.slot_id);
    if (!r.guardian_id || !slotInfo) { orphaned.push(r); continue; }
    const key = `${r.guardian_id}|${slotInfo.date}`;
    const arr = groupsByGuardianDate.get(key) ?? [];
    arr.push(r);
    groupsByGuardianDate.set(key, arr);
  }
  for (const r of orphaned) {
    skipped++;
    details.push({ id: r.id, result: 'skipped', note: 'no guardian_id or slot info' });
  }

  for (const [groupKey, groupReservations] of groupsByGuardianDate) {
    const [guardianId, slotDate] = groupKey.split('|');
    const rep = groupReservations[0];
    const guardian = rep.guardians;

    if (!guardian?.email) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no guardian email' });
      }
      continue;
    }

    // group 内全予約 × active 参加者を bookings 配列に集約
    const bookings: Array<{
      courseName: string;
      courseKind: CourseKind;
      startTime: string;
      participantNames: string[];
    }> = [];
    for (const r of groupReservations) {
      const slotInfo = slotInfoById.get(r.slot_id);
      if (!slotInfo) continue;
      const activeParticipants = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled'
      );
      if (activeParticipants.length === 0) continue;
      bookings.push({
        courseName: slotInfo.courseName,
        courseKind: classifyCourse(slotInfo.courseCode),
        startTime: slotInfo.startTime,
        participantNames: activeParticipants.map((p: any) => p.name_snapshot),
      });
    }
    if (bookings.length === 0) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no active participants' });
      }
      continue;
    }
    // 読みやすさのため開始時刻昇順に並べる (10:00 → 14:00 の順)
    bookings.sort((a, b) => a.startTime.localeCompare(b.startTime));

    const isTomorrow = slotDate === tomorrowJst;
    const dayLabel = isTomorrow ? '明日' : '本日';
    // Resend Idempotency-Key: (guardian, date) 決定的キー。二重送信 safety net。
    const idempotencyKey = `reminder:${slotDate}:${guardianId}`;

    try {
      await sendReminderEmail(env, {
        to: guardian.email,
        guardianName: guardian.name,
        slotDate,
        dayLabel,
        bookings,
        idempotencyKey,
      });

      // group 内全予約の flag を 1 UPDATE で同時セット (atomic)。
      // 一時的な Supabase 通信エラーには backoff 付きで 3 回リトライ。
      const ids = groupReservations.map((r: any) => r.id);
      const sentAt = new Date().toISOString();
      let updErr: { message: string } | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error } = await supabase
          .from('reservations')
          .update({ reminder_email_sent_at: sentAt })
          .in('id', ids);
        if (!error) { updErr = null; break; }
        updErr = error;
        console.warn(
          `[reminder-mail] flag UPDATE attempt ${attempt}/3 failed for group`,
          ids, error.message,
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 600));
        }
      }
      if (updErr) {
        console.warn(
          '[reminder-mail] failed to mark sent for group after 3 attempts',
          ids, updErr.message,
        );
        flagUpdateErrors.push({
          groupIds: ids,
          error: `${updErr.message} (after 3 retries)`,
        });
      }

      const noteBits: string[] = [];
      if (groupReservations.length > 1) noteBits.push(`grouped=${groupReservations.length}`);
      noteBits.push(dayLabel);
      const noteStr = noteBits.join(' ');
      for (const r of groupReservations) {
        sent++;
        details.push({ id: r.id, result: 'sent', note: noteStr });
      }
    } catch (e: any) {
      for (const r of groupReservations) {
        failed++;
        details.push({ id: r.id, result: 'failed', note: e?.message ?? String(e) });
      }
      console.warn('[reminder-mail] failed for group', groupReservations.map((r: any) => r.id), e);
    }
  }

      // メール送信は成功したが flag UPDATE に失敗した group が 1 つでも
      // あれば、cron 全体を error 扱いにする。Resend Idempotency-Key で
      // 二重送信自体は 24h 以内なら防げるが、DB 不整合は必ず記録。
      if (flagUpdateErrors.length > 0) {
        const failedGroupIds = flagUpdateErrors.flatMap((e) => e.groupIds);
        const okCount = sent - failedGroupIds.length;
        throw new Error(
          `[reminder-mail] mail-sent but flag-update FAILED for ${flagUpdateErrors.length} ` +
          `group(s) covering ${failedGroupIds.length} reservation(s). ` +
          `Resend Idempotency-Key prevents actual re-send within 24h. ` +
          `Success: sent=${okCount}. Failed reservation IDs: [${failedGroupIds.join(',')}]. ` +
          `First DB error: ${flagUpdateErrors[0].error}`
        );
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
  /** 同一 (guardian, slot.date) 内の全予約分。開始時刻昇順で渡す想定。 */
  bookings: Array<{
    courseName: string;
    courseKind: CourseKind;
    startTime: string; // "HH:MM:SS" or "HH:MM"
    participantNames: string[];
  }>;
  slotDate: string;
  dayLabel: string; // 「明日」or「本日」(group 全体で共通、同一日なので)
  /**
   * Resend Idempotency-Key。同一 key の再送信リクエストは Resend 側で
   * dedup され、実際にはメールが飛ばない (24h 保持)。
   */
  idempotencyKey?: string;
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
  // Subject: 1 予約なら「〜 コース名」、複数なら「〜 コースA / コースB」
  const coursesLabel = args.bookings.map((b) => b.courseName).join(' / ');
  const subject = `${args.dayLabel}はご参加をお待ちしております — ${coursesLabel}`;

  // 持ち物ロジック集約:
  //   - group 内に非 taiken (repeat / challenge) があれば「軍手/グローブ持参」必須
  //   - group 内に taiken があれば「軍手は初回参加者にプレゼント」を補足
  //   - 全て taiken なら「運動靴のみ」+ 軍手プレゼント補足
  const hasNonTaiken = args.bookings.some((b) => b.courseKind !== 'taiken');
  const hasTaiken = args.bookings.some((b) => b.courseKind === 'taiken');
  const itemsText = hasNonTaiken
    ? '運動靴・軍手 (またはグローブ)'
    : '運動靴のみ';
  const itemsHtmlLines = [
    '<li><strong>運動靴</strong></li>',
    ...(hasNonTaiken
      ? ['<li><strong>軍手 または グローブ</strong></li>']
      : []),
    '<li>つなぎ・ヘルメットは当校で無料貸出します</li>',
    ...(hasTaiken
      ? ['<li>軍手は初回参加者 (体験教室) にプレゼント (2 回目以降はご持参)</li>']
      : []),
  ].join('');

  // 予約セクション: 1 予約なら従来通り縦並び、複数なら箇条書き
  const bookingsTextLines: string[] = [];
  if (args.bookings.length === 1) {
    const b = args.bookings[0];
    bookingsTextLines.push(
      `コース: ${b.courseName}`,
      `開始時刻: ${b.startTime.slice(0, 5)}`,
      `受付開始: ${checkInLabel(b.startTime)} (開始 15 分前)`,
      `参加者: ${b.participantNames.join(' / ')}`,
    );
  } else {
    for (const b of args.bookings) {
      bookingsTextLines.push(
        `● ${b.courseName}`,
        `  開始 ${b.startTime.slice(0, 5)} / 受付開始 ${checkInLabel(b.startTime)} (開始 15 分前)`,
        `  参加者: ${b.participantNames.join(' / ')}`,
        '',
      );
    }
  }

  const text = [
    `${args.guardianName} 様`,
    '',
    `${args.dayLabel} ${dateLabel} は福岡キッズカートアカデミーへのご来校、`,
    'お待ちしております。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `▼ ご予約内容${args.bookings.length > 1 ? ` (${args.bookings.length} 件)` : ''}`,
    '━━━━━━━━━━━━━━━━━━━━',
    ...bookingsTextLines,
    ...(args.bookings.length === 1 ? [''] : []),
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ 持ち物',
    '━━━━━━━━━━━━━━━━━━━━',
    `  ${itemsText}`,
    '  ※つなぎ・ヘルメットは当校で無料貸出',
    ...(hasTaiken ? ['  ※軍手は初回参加者 (体験教室) にプレゼント'] : []),
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

  // HTML: 予約セクションを bookings 数に応じて構成
  const bookingsHtml = args.bookings.length === 1
    ? (() => {
        const b = args.bookings[0];
        return `
      <div style="font-size:.9rem;line-height:1.9">
        <div><strong>${escapeHtml(dateLabel)}</strong></div>
        <div>コース: <strong>${escapeHtml(b.courseName)}</strong></div>
        <div>開始時刻: <strong>${escapeHtml(b.startTime.slice(0, 5))}</strong></div>
        <div style="color:#e5631a;font-weight:700">受付開始: ${escapeHtml(checkInLabel(b.startTime))} (開始 15 分前)</div>
        <div style="margin-top:.4rem">参加者: ${escapeHtml(b.participantNames.join(' / '))}</div>
      </div>`;
      })()
    : `
      <div style="font-size:.88rem;line-height:1.9;margin-bottom:.5rem"><strong>${escapeHtml(dateLabel)}</strong> (ご予約 ${args.bookings.length} 件)</div>
      ${args.bookings.map((b) => `
        <div style="background:#fff;border:1px solid #d8e6f0;border-radius:8px;padding:.7rem .9rem;margin-top:.5rem">
          <div style="font-weight:800;color:#163048;font-size:.9rem;margin-bottom:.3rem">${escapeHtml(b.courseName)}</div>
          <div style="font-size:.85rem;line-height:1.8">
            <div>開始 <strong>${escapeHtml(b.startTime.slice(0, 5))}</strong> · <span style="color:#e5631a;font-weight:700">受付開始 ${escapeHtml(checkInLabel(b.startTime))}</span> (開始 15 分前)</div>
            <div>参加者: ${escapeHtml(b.participantNames.join(' / '))}</div>
          </div>
        </div>
      `).join('')}`;

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🏁</div>
    <h2 style="text-align:center;margin:0 0 .5rem;font-size:1.15rem">${escapeHtml(args.dayLabel)}はご参加をお待ちしております！</h2>
    <p style="text-align:center;margin:0 0 1.2rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>

    <div style="background:rgba(58,169,232,.08);border:1px solid #cae7f7;border-radius:10px;padding:1rem;margin:1rem 0">
      <div style="font-weight:800;color:#1a7fb8;font-size:.85rem;margin-bottom:.5rem">ご予約内容${args.bookings.length > 1 ? ` (${args.bookings.length} 件)` : ''}</div>
      ${bookingsHtml}
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

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (args.idempotencyKey) {
    headers['Idempotency-Key'] = args.idempotencyKey;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
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
