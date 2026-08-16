import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/cron/thankyou-mail
//
// 予約当日 18:00 JST に GitHub Actions cron から叩かれる。
// その日開催された全予約に対して、参加者ごとの skill_level と参加コース
// で分岐した「サンキュー＋次回案内」メールを保護者宛に送る。
// 二重送信防止のため reservations.thankyou_email_sent_at を記録。
//
// 認証: x-cron-secret ヘッダで env.CRON_SECRET と一致確認。
//
// 分岐ロジック (参加者ごと):
//   ・taiken × 単独走行未クリア (first_time/needs_re_lecture)
//        → 「またぜひ体験教室にお越しください」
//   ・taiken × solo_ok 以上
//        → 「リピート練習」の案内
//   ・repeat_* × solo_ok
//        → リピート練習の継続案内
//   ・repeat_* × challenge_recommended 以上
//        → リピート＋チャレンジ両方の案内
//   ・challenge_* × 任意
//        → チャレンジの継続案内
//
// レスポンス: { total, sent, skipped, failed, details }

type SkillLevel =
  | 'first_time'
  | 'needs_re_lecture'
  | 'solo_ok'
  | 'challenge_recommended'
  | 'challenge_active';

type CourseKind = 'taiken' | 'repeat' | 'challenge' | 'other';

interface Participant {
  name: string;
  skill_level: SkillLevel;
  next_step: NextStep;
}

interface NextStep {
  label: string;
  detail: string;
  primaryUrl: string;
  secondaryUrl?: string;
  secondaryLabel?: string;
}

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

  // --- Today (JST) --------------------------------------------------------
  // Query param ?date=YYYY-MM-DD で日付上書き可 (手動再送・テスト用)
  const urlObj = new URL(request.url);
  const dateOverride = urlObj.searchParams.get('date');
  const targetDate = dateOverride || todayInJst();

  const origin = env.PUBLIC_APP_URL || `${urlObj.protocol}//${urlObj.host}`;
  const surveyUrl = (env.PUBLIC_SURVEY_URL ?? '').trim();

  // --- Fetch today's slots (not cancelled) -------------------------------
  const { data: slots, error: slotsErr } = await supabase
    .from('slots')
    .select('id, date, start_time, courses(code, name)')
    .eq('date', targetDate)
    .neq('status', 'cancelled');
  if (slotsErr) {
    return json({ error: `failed to fetch slots: ${slotsErr.message}` }, 500);
  }
  const slotIds = (slots ?? []).map((s: any) => s.id);
  if (slotIds.length === 0) {
    return json({ ok: true, date: targetDate, total: 0, sent: 0, note: 'no slots today' });
  }
  const slotById = new Map<string, { courseCode: string; courseName: string }>();
  for (const s of slots as any[]) {
    slotById.set(s.id, {
      courseCode: s.courses?.code ?? '',
      courseName: s.courses?.name ?? '',
    });
  }

  // --- Fetch reservations for those slots (active + not yet sent) --------
  const { data: reservations, error: rErr } = await supabase
    .from('reservations')
    .select(`
      id, slot_id, status, thankyou_email_sent_at,
      guardians(id, name, email),
      reservation_participants(
        id, name_snapshot, attendance_status,
        customers(id, current_skill_level)
      )
    `)
    .in('slot_id', slotIds)
    .in('status', ['confirmed', 'attended'])
    .is('thankyou_email_sent_at', null);
  if (rErr) {
    return json({ error: `failed to fetch reservations: ${rErr.message}` }, 500);
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

      const slotInfo = slotById.get(r.slot_id);
      if (!slotInfo) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'slot info missing' });
        continue;
      }

      const courseKind = classifyCourse(slotInfo.courseCode);

      // Filter out participants who didn't attend
      const activeParticipants = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled' && p.attendance_status !== 'no_show'
      );
      if (activeParticipants.length === 0) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no attended participants' });
        continue;
      }

      const participants: Participant[] = activeParticipants.map((p: any) => {
        const skill: SkillLevel = p.customers?.current_skill_level ?? 'first_time';
        return {
          name: p.name_snapshot,
          skill_level: skill,
          next_step: nextStepFor(courseKind, skill, origin),
        };
      });

      await sendThankyouEmail(env, {
        to: guardian.email,
        guardianName: guardian.name,
        courseName: slotInfo.courseName,
        participants,
        surveyUrl,
        origin,
      });

      const { error: updErr } = await supabase
        .from('reservations')
        .update({ thankyou_email_sent_at: new Date().toISOString() })
        .eq('id', r.id);
      if (updErr) {
        console.warn('[thankyou-mail] failed to mark sent for', r.id, updErr.message);
      }

      sent++;
      details.push({ id: r.id, result: 'sent' });
    } catch (e: any) {
      failed++;
      details.push({ id: r.id, result: 'failed', note: e?.message ?? String(e) });
      console.warn('[thankyou-mail] failed for', r.id, e);
    }
  }

  return json({ ok: true, date: targetDate, total, sent, skipped, failed, details });
};

// Also allow GET for easy manual testing (still requires secret)
export const GET = POST;

// --- Helpers ---------------------------------------------------------------

function todayInJst(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // en-CA returns YYYY-MM-DD
  return parts;
}

function classifyCourse(code: string): CourseKind {
  if (code === 'taiken') return 'taiken';
  if (code.startsWith('repeat_')) return 'repeat';
  if (code.startsWith('challenge_')) return 'challenge';
  return 'other';
}

function skillRank(s: SkillLevel): number {
  return {
    first_time: 0,
    needs_re_lecture: 0,
    solo_ok: 1,
    challenge_recommended: 2,
    challenge_active: 2,
  }[s];
}

function nextStepFor(kind: CourseKind, skill: SkillLevel, origin: string): NextStep {
  const rank = skillRank(skill);
  const reserveBase = `${origin}/reserve`;
  const repeatUrl = `${reserveBase}?course=repeat_60`;
  const repeat25Url = `${reserveBase}?course=repeat_30`;
  const challengeTsUrl = `${reserveBase}?course=challenge_ts`;
  const taikenUrl = `${reserveBase}?course=taiken`;

  if (kind === 'taiken') {
    if (rank === 0) {
      return {
        label: 'またぜひ体験にお越しください',
        detail: '今回のご参加ありがとうございました。もう一度体験教室にご参加いただけると、さらに上達できます。',
        primaryUrl: taikenUrl,
      };
    }
    // solo_ok 以上
    return {
      label: '🎉 単独走行 OK！次はリピート練習へ',
      detail: '今回のご参加でひとりで運転できるようになりました！次はリピート練習で腕を磨きませんか？50分・25分の 2 コースからお選びいただけます。',
      primaryUrl: repeatUrl,
      secondaryUrl: repeat25Url,
      secondaryLabel: '短めの 25 分コースはこちら',
    };
  }

  if (kind === 'repeat') {
    if (rank >= 2) {
      // challenge_recommended 以上
      return {
        label: 'チャレンジクラス挑戦のご提案',
        detail: 'とても上達されました！本格的なチャレンジクラス (トヨピー) にステップアップしてみませんか？もちろんリピート練習も継続していただけます。',
        primaryUrl: challengeTsUrl,
        secondaryUrl: repeatUrl,
        secondaryLabel: 'リピート練習を続ける',
      };
    }
    // solo_ok
    return {
      label: '継続してリピート練習で上達を',
      detail: '継続は力なり。次回のリピート練習をご予約ください。',
      primaryUrl: repeatUrl,
      secondaryUrl: repeat25Url,
      secondaryLabel: '短めの 25 分コースはこちら',
    };
  }

  if (kind === 'challenge') {
    return {
      label: '次回のチャレンジクラスはこちら',
      detail: '本日はお疲れさまでした。次回のチャレンジクラスもぜひ挑戦してください。',
      primaryUrl: challengeTsUrl,
    };
  }

  return {
    label: '次回のご予約はこちら',
    detail: '',
    primaryUrl: reserveBase,
  };
}

async function sendThankyouEmail(env: Env, args: {
  to: string;
  guardianName: string;
  courseName: string;
  participants: Participant[];
  surveyUrl: string;
  origin: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[thankyou-mail] SKIP send: RESEND_API_KEY not set');
    return;
  }

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';
  const replyTo = env.MAIL_REPLY_TO || undefined;

  const subject = `本日はご参加ありがとうございました！ — 福岡キッズカートアカデミー`;

  const text = [
    `${args.guardianName} 様`,
    '',
    '本日は福岡キッズカートアカデミーにお越しいただき、',
    '誠にありがとうございました。',
    '',
    `▼ 本日のコース: ${args.courseName}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ お子さまごとの次回のご案内',
    '━━━━━━━━━━━━━━━━━━━━',
    ...args.participants.flatMap((p) => [
      '',
      `● ${p.name} さん`,
      `  → ${p.next_step.label}`,
      ...(p.next_step.detail ? [`  ${p.next_step.detail}`] : []),
      `  ▶ ご予約: ${p.next_step.primaryUrl}`,
      ...(p.next_step.secondaryUrl && p.next_step.secondaryLabel
        ? [`  ▶ ${p.next_step.secondaryLabel}: ${p.next_step.secondaryUrl}`]
        : []),
    ]),
    '',
    ...(args.surveyUrl ? [
      '━━━━━━━━━━━━━━━━━━━━',
      '▼ ご感想アンケート（1 分で終わります）',
      `${args.surveyUrl}`,
      '',
      'サービス改善のためにご協力をお願いいたします。',
      '',
    ] : []),
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '✉️ info@kidskart.org',
    '📞 092-927-1177',
    '🌐 https://kidskart.org/',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const participantsHtml = args.participants.map((p) => `
    <div style="border:1px solid #d8e6f0;border-radius:10px;padding:.9rem;margin-bottom:.7rem;background:#fff">
      <div style="font-weight:800;color:#163048;font-size:.95rem;margin-bottom:.3rem">👦 ${escapeHtml(p.name)} さん</div>
      <div style="font-weight:700;color:#e5631a;font-size:.85rem;margin-bottom:.3rem">${escapeHtml(p.next_step.label)}</div>
      ${p.next_step.detail ? `<p style="font-size:.8rem;color:#3d556f;margin:.3rem 0 .7rem;line-height:1.65">${escapeHtml(p.next_step.detail)}</p>` : ''}
      <p style="margin:.4rem 0">
        <a href="${escapeAttr(p.next_step.primaryUrl)}" style="display:inline-block;padding:.55rem 1.1rem;background:linear-gradient(135deg,#ff8a3d,#e5631a);color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.82rem">ご予約はこちら</a>
      </p>
      ${p.next_step.secondaryUrl && p.next_step.secondaryLabel ? `
        <p style="margin:.4rem 0 0"><a href="${escapeAttr(p.next_step.secondaryUrl)}" style="color:#1a7fb8;text-decoration:none;font-size:.78rem;font-weight:700">▶ ${escapeHtml(p.next_step.secondaryLabel)}</a></p>
      ` : ''}
    </div>
  `).join('');

  const surveyHtml = args.surveyUrl ? `
    <div style="background:linear-gradient(135deg,rgba(58,169,232,.08),rgba(58,169,232,.02));border:1px solid #cae7f7;border-radius:10px;padding:1rem;margin:1.2rem 0;text-align:center">
      <div style="font-weight:800;color:#1a7fb8;font-size:.95rem;margin-bottom:.4rem">📝 ご感想アンケート</div>
      <p style="font-size:.8rem;color:#3d556f;margin:0 0 .7rem">1 分で終わります。サービス改善のためご協力をお願いします。</p>
      <p style="margin:0">
        <a href="${escapeAttr(args.surveyUrl)}" style="display:inline-block;padding:.55rem 1.1rem;background:#1a7fb8;color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.82rem">アンケートに回答する</a>
      </p>
    </div>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🎉</div>
    <h2 style="text-align:center;margin:0 0 .5rem;font-size:1.15rem">本日はご参加ありがとうございました！</h2>
    <p style="text-align:center;margin:0 0 1.2rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>

    <p style="font-size:.88rem;color:#163048;line-height:1.7;margin:0 0 1rem">
      本日は福岡キッズカートアカデミーにお越しいただき、誠にありがとうございました。<br>
      本日のコース: <strong>${escapeHtml(args.courseName)}</strong>
    </p>

    <div style="background:rgba(255,201,67,.08);border-top:2px solid #ffc943;border-bottom:2px solid #ffc943;padding:.7rem;margin:1.2rem 0 1rem;text-align:center">
      <div style="font-weight:800;color:#e5631a;font-size:.95rem">▼ お子さまごとの次回のご案内</div>
    </div>

    ${participantsHtml}

    ${surveyHtml}

    <div style="background:linear-gradient(135deg,rgba(6,199,85,.06),rgba(6,199,85,.02));border:1px solid #06c755;border-radius:10px;padding:.9rem;margin:1rem 0;text-align:center">
      <div style="font-weight:800;color:#06c755;font-size:.9rem;margin-bottom:.4rem">🔔 開催のお知らせを受け取る</div>
      <p style="font-size:.76rem;color:#3d556f;margin:0 0 .7rem">新しいスケジュールが公開されたら通知を受け取れます</p>
      <p style="margin:0">
        <a href="https://line.me/R/ti/p/@kidskart" style="display:inline-block;padding:.55rem 1.1rem;background:#06c755;color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.82rem">💬 LINE 友達追加</a>
      </p>
    </div>

    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:1.5rem 0 0;border-top:1px solid #d8e6f0;padding-top:1rem">
      福岡キッズカートアカデミー / エーワンサーキット<br>
      ✉️ <a href="mailto:info@kidskart.org" style="color:#1a7fb8;text-decoration:none">info@kidskart.org</a> / 📞 <a href="tel:0929271177" style="color:#1a7fb8;text-decoration:none">092-927-1177</a><br>
      🌐 <a href="https://kidskart.org/" style="color:#1a7fb8;text-decoration:none">kidskart.org</a>
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
