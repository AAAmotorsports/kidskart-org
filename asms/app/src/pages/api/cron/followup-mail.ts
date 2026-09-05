import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { logCronRun } from '@lib/cron-log';

export const prerender = false;

// POST /api/cron/followup-mail
//
// 毎日 19:00 JST に GitHub Actions cron から叩かれる。
// 対象: 30 日前 (JST) に開催されて、その後 1 度も新予約がない保護者の予約。
// 各対象保護者に対して「その後お子さまいかがですか？」の再エンゲージメント
// メールを送る。二重送信防止のため reservations.followup_email_sent_at
// を記録。
//
// 送信単位: **guardian 単位で 1 通** (2026-09-02 変更)。
// 同一保護者が同日に複数予約していた場合、全予約分を 1 通に集約する。
// 参加者名は合算、コース名は " / " 連結、次ステップ提案は代表参加者の
// skill_level で判定。DB の predicate flag (followup_email_sent_at) は
// 従来通り予約単位で持ち、送信成功時は group 内全予約を 1 UPDATE で
// 同時セット (Postgres 単一 UPDATE は atomic)。
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

  try {
    const result = await logCronRun(supabase, 'followup-mail', async () => {
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
    throw new Error(`failed to fetch slots: ${slotsErr.message}`);
  }
  const slotIds = (slots ?? []).map((s: any) => s.id);
  if (slotIds.length === 0) {
    return { target_date: targetDate, total: 0, sent: 0, note: 'no slots on target date' };
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
    throw new Error(`failed to fetch reservations: ${rErr.message}`);
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
  // flag UPDATE 失敗を貯める配列 (メール送信は成功したが DB flag update
  // が失敗したケース)。ループ完了後に配列が空でなければ throw して cron
  // 全体を error 扱いにする → admin パネルで赤バッジ → 気付ける。
  // 「メール送信成功 → flag 未セット → 次回 cron で同じメール再送」
  // という二重送信リスクの検知手段。
  const flagUpdateErrors: Array<{ groupIds: string[]; error: string }> = [];

  // 同一保護者の複数予約を 1 通に集約する。フォローアップは営業性の
  // 強い再エンゲージメントメールなので、同じ保護者に 2 通並列で送るのは
  // 疲弊感を招く。DB の予約単位 idempotency flag はそのまま維持しつつ、
  // 送信処理だけ guardian でまとめる。
  const groupsByGuardian = new Map<string, any[]>();
  const orphaned: any[] = [];
  for (const r of (candidates ?? []) as any[]) {
    if (!r.guardian_id) { orphaned.push(r); continue; }
    const arr = groupsByGuardian.get(r.guardian_id) ?? [];
    arr.push(r);
    groupsByGuardian.set(r.guardian_id, arr);
  }
  for (const r of orphaned) {
    skipped++;
    details.push({ id: r.id, result: 'skipped', note: 'no guardian_id' });
  }

  for (const [guardianId, groupReservations] of groupsByGuardian) {
    const rep = groupReservations[0];
    const guardian = rep.guardians;

    // Guardian が 30 日以内に新規予約を持つ (=リピーター化) → group 全体 skip
    if (laterActiveGuardians.has(guardianId)) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'guardian has later reservation' });
      }
      continue;
    }
    if (!guardian?.email) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no guardian email' });
      }
      continue;
    }

    // group 内全予約の active 参加者・コース名を集約
    const allParticipantNames: string[] = [];
    const courseNames: string[] = [];
    let representativeSlotInfo: { courseCode: string; courseName: string } | null = null;
    let representativeSkill: SkillLevel = 'first_time';
    let representativeSkillSet = false;
    for (const r of groupReservations) {
      const slotInfo = slotInfoById.get(r.slot_id);
      if (!slotInfo) continue;
      if (!representativeSlotInfo) representativeSlotInfo = slotInfo;
      if (slotInfo.courseName && !courseNames.includes(slotInfo.courseName)) {
        courseNames.push(slotInfo.courseName);
      }
      const active = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled' && p.attendance_status !== 'no_show'
      );
      for (const p of active) {
        allParticipantNames.push(p.name_snapshot);
        if (!representativeSkillSet) {
          representativeSkill = (p.customers?.current_skill_level as SkillLevel) ?? 'first_time';
          representativeSkillSet = true;
        }
      }
    }
    if (allParticipantNames.length === 0 || !representativeSlotInfo) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no attended participants' });
      }
      continue;
    }

    // 次ステップ提案 = 代表参加者の skill × 代表コース種別 (最小変更方針、
    // 混在時は代表 1 名で判定。「詳しくはリンクから」で十分)
    const courseKind = classifyCourse(representativeSlotInfo.courseCode);
    const nextStep = nextStepFor(courseKind, representativeSkill, origin);

    // Google 口コミ依頼: 未依頼の保護者にだけ 1 度 opportunistic に
    const askReview = !guardian.google_review_asked_at && !!googleReviewUrl;

    // Resend Idempotency-Key: cron 自動発火では
    // "followup:<targetDate>:<guardianId>" の決定的キーで dedup。
    // 「メール送信成功 → DB flag UPDATE 失敗 → 次日 cron 再抽出」
    // で同じメールが Resend まで届いても 24h 以内なら Resend 側で
    // 実送信をブロック (二重送信 safety net 第 1 段)。
    const idempotencyKey = `followup:${targetDate}:${guardianId}`;

    try {
      await sendFollowupEmail(env, {
        to: guardian.email,
        guardianName: guardian.name,
        participantNames: allParticipantNames,
        courseName: courseNames.join(' / '), // 複数コース混在時は "/" 連結
        nextStep,
        googleReviewUrl: askReview ? googleReviewUrl : '',
        idempotencyKey,
      });

      // group 内全予約の flag を 1 UPDATE で同時セット (Postgres 単一
      // UPDATE 文は atomic なので部分更新にならない)。
      // 一時的な Supabase 通信エラーに対しては backoff 付きで最大 3 回
      // リトライ (safety net 第 2 段: 翌日まで持ち越さず即回復)。
      // 3 回全部失敗した場合のみ flagUpdateErrors に積んで最終的に
      // cron を error 扱いにする。
      const ids = groupReservations.map((r: any) => r.id);
      const sentAt = new Date().toISOString();
      let updErr: { message: string } | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error } = await supabase
          .from('reservations')
          .update({ followup_email_sent_at: sentAt })
          .in('id', ids);
        if (!error) { updErr = null; break; }
        updErr = error;
        console.warn(
          `[followup-mail] flag UPDATE attempt ${attempt}/3 failed for group`,
          ids, error.message,
        );
        if (attempt < 3) {
          // 200ms → 600ms の指数的 backoff。合計最大 ~800ms 遅延。
          await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 600));
        }
      }
      if (updErr) {
        console.warn(
          '[followup-mail] failed to mark sent for group after 3 attempts',
          ids, updErr.message,
        );
        flagUpdateErrors.push({
          groupIds: ids,
          error: `${updErr.message} (after 3 retries)`,
        });
      }
      if (askReview && guardianId) {
        const { error: revErr } = await supabase
          .from('guardians')
          .update({ google_review_asked_at: new Date().toISOString() })
          .eq('id', guardianId);
        if (revErr) {
          console.warn('[followup-mail] failed to mark review-asked for', guardianId, revErr.message);
        }
      }

      const noteBits: string[] = [];
      if (groupReservations.length > 1) noteBits.push(`grouped=${groupReservations.length}`);
      if (askReview) noteBits.push('review-cta');
      const noteStr = noteBits.join(' ') || undefined;
      for (const r of groupReservations) {
        sent++;
        details.push({ id: r.id, result: 'sent', note: noteStr });
      }
    } catch (e: any) {
      for (const r of groupReservations) {
        failed++;
        details.push({ id: r.id, result: 'failed', note: e?.message ?? String(e) });
      }
      console.warn('[followup-mail] failed for group', groupReservations.map((r: any) => r.id), e);
    }
  }

      // メール送信は成功したが flag UPDATE に失敗した group が 1 つでも
      // あれば、cron 全体を error 扱いにする (次回 cron で同じ保護者に
      // 再送されるリスクを admin パネルの赤バッジで気付けるようにする)。
      // sent/failed カウンタ等は throw で消えるので、必要情報を error
      // message に埋め込む。
      if (flagUpdateErrors.length > 0) {
        const failedGroupIds = flagUpdateErrors.flatMap((e) => e.groupIds);
        const okCount = sent - failedGroupIds.length;
        throw new Error(
          `[followup-mail] mail-sent but flag-update FAILED for ${flagUpdateErrors.length} ` +
          `group(s) covering ${failedGroupIds.length} reservation(s). ` +
          `Next cron will RE-SEND these to the guardian(s). ` +
          `Success: sent=${okCount}. Failed reservation IDs: [${failedGroupIds.join(',')}]. ` +
          `First DB error: ${flagUpdateErrors[0].error}`
        );
      }
      return { target_date: targetDate, total, sent, skipped, failed, details };
    });
    return json({ ok: true, ...result });
  } catch (e: any) {
    return json({ error: e?.message ?? String(e) }, 500);
  }
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
  /**
   * Resend Idempotency-Key。同一 key の再送信リクエストは Resend 側で
   * dedup され、実際にはメールが飛ばない (24h 保持)。
   * 「メール送信成功 → DB flag UPDATE 失敗 → 次回 cron で同じ対象再抽出」
   * の二重送信を Resend レイヤで防ぐための safety net。
   */
  idempotencyKey?: string;
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
