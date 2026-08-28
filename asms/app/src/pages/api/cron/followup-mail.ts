import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/cron/followup-mail
//
// 毎日 19:00 JST に GitHub Actions cron から叩かれる。
// 対象: 30 日前 (JST) に開催されて、その後 1 度も新予約がない保護者の予約。
// 各対象予約に対して「その後お子さまいかがですか？」の再エンゲージメント
// メールを保護者に送る。二重送信防止のため reservations.followup_email_sent_at
// を記録。保護者単位で「1 回だけ」の運用 (再エンゲージメントメールを短期に
// 何度も送るのは嫌がられるので、reservation 単位で判定するけど実質同じ)。
//
// 発火頻度は日次だが、対象は「30 日前ぴったりに開催した予約」なので、
// 毎日せいぜい 1-3 件しか送られない。
//
// 認証: x-cron-secret ヘッダで env.CRON_SECRET と一致確認。

type SkillLevel =
  | 'first_time'
  | 'needs_re_lecture'
  | 'solo_ok'
  | 'challenge_recommended'
  | 'challenge_active';

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
  const urlObj = new URL(request.url);
  const dateOverride = urlObj.searchParams.get('date');
  const origin = env.PUBLIC_APP_URL || `${urlObj.protocol}//${urlObj.host}`;
  const googleReviewUrl = (env.PUBLIC_GOOGLE_REVIEW_URL ?? '').trim();

  // 対象日 = 30 日前 (JST)
  const todayJst = todayInJst();
  const targetDate = dateOverride || addDaysJst(todayJst, -30);

  // --- Fetch slots on target date ----------------------------------------
  const { data: slots, error: slotsErr } = await supabase
    .from('slots')
    .select('id, date, courses(code, name)')
    .eq('date', targetDate)
    .neq('status', 'cancelled');
  if (slotsErr) {
    return json({ error: `failed to fetch slots: ${slotsErr.message}` }, 500);
  }
  const slotIds = (slots ?? []).map((s: any) => s.id);
  if (slotIds.length === 0) {
    return json({ ok: true, target_date: targetDate, total: 0, sent: 0, note: 'no slots on target date' });
  }
  const slotInfoById = new Map<string, { courseCode: string; courseName: string }>();
  for (const s of slots as any[]) {
    slotInfoById.set(s.id, {
      courseCode: s.courses?.code ?? '',
      courseName: s.courses?.name ?? '',
    });
  }

  // --- Reservations on target date, not yet followed-up ------------------
  const { data: candidates, error: rErr } = await supabase
    .from('reservations')
    .select(`
      id, slot_id, status, guardian_id, followup_email_sent_at,
      guardians(id, name, email, google_review_asked_at),
      reservation_participants(id, name_snapshot, attendance_status, customers(current_skill_level))
    `)
    .in('slot_id', slotIds)
    .in('status', ['confirmed', 'attended'])
    .is('followup_email_sent_at', null);
  if (rErr) {
    return json({ error: `failed to fetch reservations: ${rErr.message}` }, 500);
  }

  // --- For each candidate, verify no newer reservation for same guardian -
  const guardianIds = new Set<string>();
  for (const r of (candidates ?? []) as any[]) {
    if (r.guardian_id) guardianIds.add(r.guardian_id);
  }

  // 30 日以内の任意日以降に予約がある保護者を先に洗い出す (N+1 回避)
  const laterActiveGuardians = new Set<string>();
  if (guardianIds.size > 0) {
    // 対象日より新しい日付の slots
    const { data: newerSlots } = await supabase
      .from('slots')
      .select('id')
      .gt('date', targetDate)
      .neq('status', 'cancelled');
    const newerSlotIds = (newerSlots ?? []).map((s: any) => s.id);
    if (newerSlotIds.length > 0) {
      const { data: newerReservs } = await supabase
        .from('reservations')
        .select('guardian_id')
        .in('slot_id', newerSlotIds)
        .in('guardian_id', [...guardianIds])
        .neq('status', 'cancelled');
      for (const row of (newerReservs ?? []) as any[]) {
        if (row.guardian_id) laterActiveGuardians.add(row.guardian_id);
      }
    }
  }

  const total = (candidates ?? []).length;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ id: string; result: string; note?: string }> = [];

  for (const r of (candidates ?? []) as any[]) {
    try {
      const guardian = r.guardians;
      if (!guardian?.email) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no guardian email' });
        continue;
      }
      // 30 日以内に新規予約がある保護者はスキップ (=リピーター、再エンゲ不要)
      if (r.guardian_id && laterActiveGuardians.has(r.guardian_id)) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'guardian has later reservation' });
        continue;
      }
      const slotInfo = slotInfoById.get(r.slot_id);
      if (!slotInfo) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'slot info missing' });
        continue;
      }
      const activeParticipants = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled' && p.attendance_status !== 'no_show'
      );
      if (activeParticipants.length === 0) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no attended participants' });
        continue;
      }

      // 参加者の skill_level から代表的な次のステップ提案を決める
      // (簡略化: 最初の参加者の skill を使う)
      const firstParticipant = activeParticipants[0];
      const skill: SkillLevel = firstParticipant.customers?.current_skill_level ?? 'first_time';
      const courseKind = classifyCourse(slotInfo.courseCode);
      const nextStep = nextStepFor(courseKind, skill, origin);

      // まだ Google 口コミ依頼を送ったことがない保護者だけ、opportunistic に依頼
      const askReview = !guardian.google_review_asked_at && !!googleReviewUrl;

      await sendFollowupEmail(env, {
        to: guardian.email,
        guardianName: guardian.name,
        participantNames: activeParticipants.map((p: any) => p.name_snapshot),
        courseName: slotInfo.courseName,
        nextStep,
        googleReviewUrl: askReview ? googleReviewUrl : '',
      });

      const { error: updErr } = await supabase
        .from('reservations')
        .update({ followup_email_sent_at: new Date().toISOString() })
        .eq('id', r.id);
      if (updErr) {
        console.warn('[followup-mail] failed to mark sent for', r.id, updErr.message);
      }
      if (askReview && r.guardian_id) {
        const { error: revErr } = await supabase
          .from('guardians')
          .update({ google_review_asked_at: new Date().toISOString() })
          .eq('id', r.guardian_id);
        if (revErr) {
          console.warn('[followup-mail] failed to mark review-asked for', r.guardian_id, revErr.message);
        }
      }

      sent++;
      details.push({
        id: r.id,
        result: 'sent',
        note: askReview ? 'with review CTA' : undefined,
      });
    } catch (e: any) {
      failed++;
      details.push({ id: r.id, result: 'failed', note: e?.message ?? String(e) });
      console.warn('[followup-mail] failed for', r.id, e);
    }
  }

  return json({ ok: true, target_date: targetDate, total, sent, skipped, failed, details });
};

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
  const base = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
  const next = new Date(base + days * 86400 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(next);
}

function classifyCourse(code: string): CourseKind {
  if (code === 'taiken') return 'taiken';
  if (code.startsWith('repeat_')) return 'repeat';
  if (code.startsWith('challenge_')) return 'challenge';
  return 'other';
}

interface NextStep {
  label: string;
  detail: string;
  primaryUrl: string;
  secondaryUrl?: string;
  secondaryLabel?: string;
}

function skillRank(s: SkillLevel): number {
  return { first_time: 0, needs_re_lecture: 0, solo_ok: 1, challenge_recommended: 2, challenge_active: 2 }[s];
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
        label: 'もう一度体験教室にいかがですか？',
        detail: '前回はまだ単独走行までもう少しでした。もう一度チャレンジすると、上達を実感できます。',
        primaryUrl: taikenUrl,
      };
    }
    return {
      label: '🎉 リピート練習で次のステップへ',
      detail: '前回で単独走行 OK！次はリピート練習で走行時間を伸ばして、コース攻略に挑戦しませんか？',
      primaryUrl: repeatUrl,
      secondaryUrl: repeat25Url,
      secondaryLabel: '短めの 25 分コース',
    };
  }
  if (kind === 'repeat') {
    if (rank >= 2) {
      return {
        label: 'チャレンジクラスをお待ちしております',
        detail: 'とても上達されていました。次回は本格的なチャレンジクラス (トヨピー) で、レースの雰囲気も味わえます。',
        primaryUrl: challengeTsUrl,
        secondaryUrl: repeatUrl,
        secondaryLabel: 'リピート練習を続ける',
      };
    }
    return {
      label: 'リピート練習でさらに上達',
      detail: '継続は力なり。感覚が薄れないうちに次の練習をご予約ください。',
      primaryUrl: repeatUrl,
      secondaryUrl: repeat25Url,
      secondaryLabel: '短めの 25 分コース',
    };
  }
  if (kind === 'challenge') {
    return {
      label: '次のチャレンジクラスへ',
      detail: '本気の走行はチャレンジクラスから。次回もお待ちしております。',
      primaryUrl: challengeTsUrl,
    };
  }
  return { label: '次回のご予約はこちら', detail: '', primaryUrl: reserveBase };
}

async function sendFollowupEmail(env: Env, args: {
  to: string;
  guardianName: string;
  participantNames: string[];
  courseName: string;
  nextStep: NextStep;
  googleReviewUrl: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[followup-mail] SKIP send: RESEND_API_KEY not set');
    return;
  }

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';
  const replyTo = env.MAIL_REPLY_TO || undefined;
  const subject = `お子さまはお元気ですか？ 次回のご案内 — 福岡キッズカートアカデミー`;

  const text = [
    `${args.guardianName} 様`,
    '',
    'ご無沙汰しております、福岡キッズカートアカデミーです。',
    `先月 ${args.participantNames.join(' / ')} さんにご参加いただき`,
    'ありがとうございました。',
    '',
    'お子さまのカート、その後いかがでしょうか？',
    'そろそろまた走らせてあげませんか？',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `▼ ${args.nextStep.label}`,
    '━━━━━━━━━━━━━━━━━━━━',
    ...(args.nextStep.detail ? [args.nextStep.detail, ''] : []),
    `▶ ご予約: ${args.nextStep.primaryUrl}`,
    ...(args.nextStep.secondaryUrl && args.nextStep.secondaryLabel
      ? [`▶ ${args.nextStep.secondaryLabel}: ${args.nextStep.secondaryUrl}`]
      : []),
    '',
    ...(args.googleReviewUrl ? [
      '━━━━━━━━━━━━━━━━━━━━',
      '⭐ Google でご感想をお聞かせください',
      '━━━━━━━━━━━━━━━━━━━━',
      'お子さまに楽しんでいただけましたら、Google 上でご感想を',
      'お聞かせいただけると嬉しいです。',
      '',
      `▶ ${args.googleReviewUrl}`,
      '',
    ] : []),
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '✉️ info@kidskart.org',
    '📞 092-927-1177',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  const nextHtml = `
    <div style="background:#fff;border:1px solid #d8e6f0;border-radius:10px;padding:1rem 1.15rem;margin:1rem 0">
      <div style="font-weight:800;color:#e5631a;font-size:.95rem;margin-bottom:.4rem">${escapeHtml(args.nextStep.label)}</div>
      ${args.nextStep.detail ? `<p style="font-size:.83rem;color:#3d556f;margin:.3rem 0 .8rem;line-height:1.7">${escapeHtml(args.nextStep.detail)}</p>` : ''}
      <p style="margin:.4rem 0">
        <a href="${escapeAttr(args.nextStep.primaryUrl)}" style="display:inline-block;padding:.6rem 1.2rem;background:linear-gradient(135deg,#ff8a3d,#e5631a);color:#fff;text-decoration:none;border-radius:6px;font-weight:800;font-size:.85rem">ご予約はこちら</a>
      </p>
      ${args.nextStep.secondaryUrl && args.nextStep.secondaryLabel ? `
        <p style="margin:.4rem 0 0"><a href="${escapeAttr(args.nextStep.secondaryUrl)}" style="color:#1a7fb8;text-decoration:none;font-size:.78rem;font-weight:700">▶ ${escapeHtml(args.nextStep.secondaryLabel)}</a></p>
      ` : ''}
    </div>
  `;

  const reviewHtml = args.googleReviewUrl ? `
    <div style="background:linear-gradient(135deg,rgba(255,201,67,.15),rgba(255,138,61,.08));border:2px solid #ffc943;border-radius:12px;padding:1.1rem 1rem;margin:1.2rem 0 .3rem;text-align:center">
      <div style="font-size:1.3rem;margin-bottom:.2rem">⭐️⭐️⭐️⭐️⭐️</div>
      <div style="font-weight:800;color:#163048;font-size:.95rem;margin-bottom:.4rem">Google でご感想をお聞かせください</div>
      <p style="font-size:.78rem;color:#3d556f;margin:0 0 .8rem;line-height:1.6">
        お子さまに楽しんでいただけましたら、<br>
        Google 上でひとことご感想をお願いします。
      </p>
      <p style="margin:0">
        <a href="${escapeAttr(args.googleReviewUrl)}" style="display:inline-block;padding:.65rem 1.3rem;background:linear-gradient(135deg,#4285f4,#1a73e8);color:#fff;text-decoration:none;border-radius:8px;font-weight:800;font-size:.85rem;box-shadow:0 3px 10px rgba(66,133,244,.35)">Google に口コミを書く</a>
      </p>
    </div>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🏁</div>
    <h2 style="text-align:center;margin:0 0 .5rem;font-size:1.15rem">お子さまはお元気ですか？</h2>
    <p style="text-align:center;margin:0 0 1rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>

    <p style="font-size:.88rem;color:#163048;line-height:1.75;margin:0 0 1rem">
      ご無沙汰しております、福岡キッズカートアカデミーです。<br>
      先月 <strong>${escapeHtml(args.participantNames.join(' / '))}</strong> さんにご参加いただきありがとうございました。<br><br>
      お子さまのカート、その後いかがでしょうか？そろそろまた走らせてあげませんか？
    </p>

    ${nextHtml}

    ${reviewHtml}

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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
