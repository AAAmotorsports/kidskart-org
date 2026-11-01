import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { logCronRun } from '@lib/cron-log';

export const prerender = false;

// POST /api/cron/thankyou-mail
//
// 予約当日 18:00 JST に GitHub Actions cron から叩かれる。
// その日開催された全予約に対して、参加者ごとの skill_level と参加コース
// で分岐した「サンキュー＋次回案内」メールを保護者宛に送る。
// 二重送信防止のため reservations.thankyou_email_sent_at を記録。
//
// 「授業前送信」ガード (2026-08-28 追加):
//   GitHub Actions cron はまれに数時間規模で遅延することがあり、日を
//   またぐと翌日の予約に対して「本日ありがとう」メールを授業前に
//   送ってしまう事故が起きた。対策として slot.end_time (JST) が現在
//   時刻を過ぎたスロットだけを送信対象にする (isSlotFinishedJst)。
//   dateOverride 指定時 (?date=... の手動再送) はこのガードをスキップ。
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
// 初回参加後の追加 CTA (保護者単位で 1 回だけ):
//   ・Google 口コミ CTA (メイン・目立たせる) ← Google Business Profile の
//      口コミ URL。集客に直接効くので優先。「満足者だけ Google に振り分け」
//      は Google ポリシー違反なので全員に同じ導線を出す。
//   ・内部アンケート (Google Form・従属的に小さく) ← 改善点収集。
//      Google 口コミよりも目立たせない。
//   両方とも「その保護者の過去参加数 == 0」かつ
//   guardians.google_review_asked_at IS NULL の場合のみ表示。
//   将来的にアンケート表示条件は独立して変更可能な設計。
//
// 送信単位: **(guardian, slot.date) 単位で 1 通** (2026-09-07 変更)。
// 同一保護者・同一日に複数予約があれば全予約分を 1 通に集約する。
// メール本文は予約 (コース) ごとにセクション分けし、各セクションに
// 参加者ごとの skill_level 別の next_step を並べる。Google 口コミ CTA
// と内部アンケート CTA はグループ (保護者) 単位で 1 度だけ表示。
// DB の flag (thankyou_email_sent_at) は従来通り予約単位で持ち、
// 送信成功時は group 内全予約を 1 UPDATE で同時セット (atomic)。
// Resend Idempotency-Key: "thankyou:<date>:<guardianId>" で二重送信
// 防止 (DB 更新失敗時のリカバリ用 safety net)。
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

  // -------------------------------------------------------------------------
  // テスト・プレビュー オプション (followup-mail と同じ仕様):
  //   ?preview=1               実送信・DB flag 更新せず、生成した HTML/text を
  //                           レスポンス previews に同梱。
  //   ?test_to=user@...        送信先を上書き (DB flag は set せず)。
  //   ?test_guardian_id=uuid   候補を 1 保護者に絞る (preview/test_to と必須併用)。
  //                           単体指定は 400。
  // -------------------------------------------------------------------------
  const urlObj = new URL(request.url);
  const previewOnly = urlObj.searchParams.get('preview') === '1';
  const testTo = (urlObj.searchParams.get('test_to') ?? '').trim() || null;
  const testGuardianId = (urlObj.searchParams.get('test_guardian_id') ?? '').trim() || null;

  if (testGuardianId && !previewOnly && !testTo) {
    return json({
      error: 'test_guardian_id はテスト専用です。preview=1 もしくは test_to=... と併用してください。',
      hint: 'add_preview_or_test_to',
    }, 400);
  }

  try {
    const result = await logCronRun(supabase, 'thankyou-mail', async () => {
  // --- Today (JST) --------------------------------------------------------
  // Query param ?date=YYYY-MM-DD で日付上書き可 (手動再送・テスト用)
  const dateOverride = urlObj.searchParams.get('date');
  const targetDate = dateOverride || todayInJst();

  const origin = env.PUBLIC_APP_URL || `${urlObj.protocol}//${urlObj.host}`;
  const surveyUrl = (env.PUBLIC_SURVEY_URL ?? '').trim();
  const googleReviewUrl = (env.PUBLIC_GOOGLE_REVIEW_URL ?? '').trim();

  // --- Fetch target-window slots (not cancelled) -------------------------
  // 「昨日」も対象に含める理由:
  //   GitHub Actions cron はまれに数時間規模で遅延することがあり、日を
  //   またぐと本来の対象日 (targetDate = today) の予約が翌日 catch-up
  //   まで送られなくなる。「昨日」も query に含めておけば、送信済み
  //   フラグ (thankyou_email_sent_at) で二重送信を防ぎつつ、遅延分は
  //   翌日 cron で拾える。
  //   dateOverride 指定時 (?date=... の手動再送) は指定日だけを見る。
  const dateList = dateOverride
    ? [dateOverride]
    : [addDaysJst(targetDate, -1), targetDate];
  const { data: rawSlots, error: slotsErr } = await supabase
    .from('slots')
    .select('id, date, start_time, end_time, courses(code, name)')
    .in('date', dateList)
    .neq('status', 'cancelled');
  if (slotsErr) {
    throw new Error(`failed to fetch slots: ${slotsErr.message}`);
  }

  // 「授業が終わってから」ガード:
  //   GitHub Actions cron が数時間遅延して日をまたぐと、翌日分の予約に
  //   対して「本日ありがとうございました」メールが授業前に飛んでしまう
  //   事故が発生する (2026-08-28 に実発生)。
  //   → slot.end_time (JST) が現在時刻 (JST) を過ぎたスロットだけを対象に。
  //   end_time が未設定のスロットは start_time + 90 分をフォールバックにする。
  //   dateOverride 指定時 (手動再送) はこのガードをスキップして全部送る。
  const slots = dateOverride
    ? (rawSlots ?? [])
    : (rawSlots ?? []).filter((s: any) => isSlotFinishedJst(s.date, s.end_time, s.start_time));

  const slotIds = slots.map((s: any) => s.id);
  if (slotIds.length === 0) {
    const note = (rawSlots ?? []).length === 0
      ? 'no slots today'
      : `all ${(rawSlots ?? []).length} slots today are still in progress or upcoming`;
    return { date: targetDate, total: 0, sent: 0, note };
  }
  // date も保持しておく (下の (guardian, date) グルーピングで使うため)
  const slotById = new Map<string, { date: string; courseCode: string; courseName: string }>();
  for (const s of slots as any[]) {
    slotById.set(s.id, {
      date: s.date,
      courseCode: s.courses?.code ?? '',
      courseName: s.courses?.name ?? '',
    });
  }

  // --- Fetch reservations for those slots (active) ------------------------
  //   送信済みも一旦取ってから js 側でフィルタ。こうすると「候補はあるが
  //   全部送信済み (=何も送らなかった理由)」を summary に残せる。
  const { data: allReservations, error: rErr } = await supabase
    .from('reservations')
    .select(`
      id, slot_id, status, guardian_id, thankyou_email_sent_at,
      guardians(id, name, email, google_review_asked_at),
      reservation_participants(
        id, name_snapshot, attendance_status,
        customers(id, current_skill_level)
      )
    `)
    .in('slot_id', slotIds)
    .in('status', ['confirmed', 'attended']);
  if (rErr) {
    throw new Error(`failed to fetch reservations: ${rErr.message}`);
  }
  const alreadySent = (allReservations ?? []).filter((r: any) => r.thankyou_email_sent_at != null).length;
  let reservations = (allReservations ?? []).filter((r: any) => r.thankyou_email_sent_at == null);
  // test_guardian_id 指定時は候補を 1 保護者に絞る (preview / test_to と併用)
  if (testGuardianId) {
    reservations = reservations.filter((r: any) => r.guardian_id === testGuardianId);
  }

  // --- 「初回参加か」を判定するため、対象保護者たちの過去のサンキュー
  //     メール送信回数 (=過去に参加してメール送信済みだった件数) を先に
  //     まとめて数えておく (N+1 クエリを回避)。
  //     過去件数 == 0 なら「今回が初回参加」とみなす。
  const guardianIds = new Set<string>();
  for (const r of (reservations ?? []) as any[]) {
    if (r.guardian_id) guardianIds.add(r.guardian_id);
  }
  const priorAttendCount = new Map<string, number>();
  if (guardianIds.size > 0) {
    const { data: pastRows } = await supabase
      .from('reservations')
      .select('guardian_id')
      .in('guardian_id', [...guardianIds])
      .not('thankyou_email_sent_at', 'is', null);
    for (const row of (pastRows ?? []) as any[]) {
      if (!row.guardian_id) continue;
      priorAttendCount.set(row.guardian_id, (priorAttendCount.get(row.guardian_id) ?? 0) + 1);
    }
  }

  const total = (reservations ?? []).length;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const details: Array<{ id: string; result: string; note?: string }> = [];
  const previews: Array<{ guardianId: string; to: string; subject: string; text: string; html: string }> = [];
  // flag UPDATE 失敗を貯める配列 (メール送信は成功したが DB flag update
  // が失敗したケース)。ループ完了後に配列が空でなければ throw して cron
  // 全体を error 扱いにする → admin パネルで赤バッジ → 気付ける。
  const flagUpdateErrors: Array<{ groupIds: string[]; error: string }> = [];

  // 同一保護者・同一日の複数予約を 1 通に集約する。DB の予約単位
  // idempotency flag はそのまま維持しつつ、送信処理だけ (guardian, date)
  // でまとめる。key format: "<guardianId>|<slot.date>"
  const groupsByGuardianDate = new Map<string, any[]>();
  const orphaned: any[] = [];
  for (const r of (reservations ?? []) as any[]) {
    const slotInfo = slotById.get(r.slot_id);
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
    // walk-in フォームでは email 任意なので dummy (walkin-<uuid>@noemail.local) を
    // 入れている。実在しない TLD で Resend が 400 を返し続けて cron が毎日
    // 赤くなるのを防ぐため、ここで明示的に skip する。
    // walk-in placeholder (walkin-<uuid>@noemail.local) に加え、
    // 旧 placeholder (admin-test@noemail.local 等) も全て skip 対象。
    // ホスト部が正確に 'noemail.local' のみマッチ (sub.noemail.local は含まない)。
    if (/@noemail\.local$/i.test(guardian.email)
        && !/@[^@]+\.noemail\.local$/i.test(guardian.email)) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'placeholder email (walk-in no-email)' });
      }
      continue;
    }

    // group 内全予約 × active 参加者を 2 層に集約 (2026-11-01):
    //   attendedCourses = コース → 参加した子の名前[] (「本日の参加実績」用)
    //   childSummary    = 子ごとに最高 skill + 最高 courseKind → next_step 1 つ
    //
    // 同一児童が複数枠参加 (例: 体験 + 走行) のとき、以前は枠ごとに別案内が
    // 並び「リピート or チャレンジ」が両方並んで迷う問題があった。
    // 子ごとに 1 案に集約し、最終判定の高い方 (challenge) を主役、
    // 下位 (repeat) は secondary ボタンとして補足される設計に。
    const courseKindRank: Record<CourseKind, number> = {
      other: -1, taiken: 0, repeat: 1, challenge: 2,
    };
    const attendedCoursesMap = new Map<string, Set<string>>(); // courseName → child names
    const childAgg = new Map<string, { skill: SkillLevel; maxKind: CourseKind; maxKindRank: number }>();
    for (const r of groupReservations) {
      const slotInfo = slotById.get(r.slot_id);
      if (!slotInfo) continue;
      const courseKind = classifyCourse(slotInfo.courseCode);
      const kindRank = courseKindRank[courseKind];
      const activeParticipants = (r.reservation_participants as any[]).filter(
        (p: any) => p.attendance_status !== 'cancelled' && p.attendance_status !== 'no_show'
      );
      if (activeParticipants.length === 0) continue;
      // 「参加実績」に蓄積
      if (!attendedCoursesMap.has(slotInfo.courseName)) {
        attendedCoursesMap.set(slotInfo.courseName, new Set());
      }
      for (const p of activeParticipants) {
        attendedCoursesMap.get(slotInfo.courseName)!.add(p.name_snapshot);
      }
      // 子ごとの集約 (最高 skill + 最高 courseKind)
      for (const p of activeParticipants) {
        const skill: SkillLevel = p.customers?.current_skill_level ?? 'first_time';
        const existing = childAgg.get(p.name_snapshot);
        if (!existing) {
          childAgg.set(p.name_snapshot, { skill, maxKind: courseKind, maxKindRank: kindRank });
        } else {
          if (skillRank(skill) > skillRank(existing.skill)) existing.skill = skill;
          if (kindRank > existing.maxKindRank) {
            existing.maxKind = courseKind;
            existing.maxKindRank = kindRank;
          }
        }
      }
    }
    if (childAgg.size === 0) {
      for (const r of groupReservations) {
        skipped++;
        details.push({ id: r.id, result: 'skipped', note: 'no attended participants' });
      }
      continue;
    }
    const attendedCourses = [...attendedCoursesMap.entries()].map(([courseName, names]) => ({
      courseName,
      childNames: [...names],
    }));
    const children: Participant[] = [...childAgg.entries()].map(([name, agg]) => ({
      name,
      skill_level: agg.skill,
      next_step: nextStepFor(agg.maxKind, agg.skill, origin),
    }));

    // 初回参加 CTA 判定 (guardian 単位、group 内で 1 度だけ)
    const isFirstVisit = (priorAttendCount.get(guardianId) ?? 0) === 0;
    const alreadyAsked = !!guardian.google_review_asked_at;
    const showReviewCta = isFirstVisit && !alreadyAsked && !!googleReviewUrl;
    const showSurveyCta = isFirstVisit && !!surveyUrl;

    // Resend Idempotency-Key: (guardian, date) 決定的キー。二重送信 safety net。
    const idempotencyKey = `thankyou:${slotDate}:${guardianId}`;

    try {
      // preview mode: 送信せず、生成した本文を previews に積むだけ。
      // test_to: 送信先を上書き (本来の guardian.email は無視)。
      const effectiveTo = testTo || guardian.email;
      if (previewOnly) {
        const previewBody = buildThankyouBodyForPreview({
          to: effectiveTo,
          guardianName: guardian.name,
          attendedCourses,
          children,
          surveyUrl: showSurveyCta ? surveyUrl : '',
          googleReviewUrl: showReviewCta ? googleReviewUrl : '',
          origin,
        });
        for (const r of groupReservations) {
          details.push({
            id: r.id,
            result: 'preview',
            note: `would send to ${effectiveTo}${testTo ? ' (test_to)' : ''}`,
          });
        }
        skipped += groupReservations.length;
        previews.push({
          guardianId,
          to: effectiveTo,
          subject: previewBody.subject,
          text: previewBody.text,
          html: previewBody.html,
        });
        continue;
      }

      await sendThankyouEmail(env, {
        to: effectiveTo,
        guardianName: guardian.name,
        attendedCourses,
        children,
        surveyUrl: showSurveyCta ? surveyUrl : '',
        googleReviewUrl: showReviewCta ? googleReviewUrl : '',
        origin,
        idempotencyKey,
      });

      // test_to 指定時は DB flag を触らない (本来の予約を保護して、
      // 本物の cron で後日本人に送れる状態を維持)。
      if (testTo) {
        for (const r of groupReservations) {
          details.push({ id: r.id, result: 'test-sent', note: `sent to ${testTo} (DB flag not touched)` });
        }
        sent++;
        continue;
      }

      // group 内全予約の flag を 1 UPDATE で同時セット (atomic)。
      // 一時的な Supabase 通信エラーには backoff 付きで 3 回リトライ。
      const ids = groupReservations.map((r: any) => r.id);
      const sentAt = new Date().toISOString();
      let updErr: { message: string } | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { error } = await supabase
          .from('reservations')
          .update({ thankyou_email_sent_at: sentAt })
          .in('id', ids);
        if (!error) { updErr = null; break; }
        updErr = error;
        console.warn(
          `[thankyou-mail] flag UPDATE attempt ${attempt}/3 failed for group`,
          ids, error.message,
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt === 1 ? 200 : 600));
        }
      }
      if (updErr) {
        console.warn(
          '[thankyou-mail] failed to mark sent for group after 3 attempts',
          ids, updErr.message,
        );
        flagUpdateErrors.push({
          groupIds: ids,
          error: `${updErr.message} (after 3 retries)`,
        });
      }

      // Google 口コミ CTA を出したなら保護者に印を付ける (guardian 単位で 1 回)。
      if (showReviewCta && guardianId) {
        const { error: revErr } = await supabase
          .from('guardians')
          .update({ google_review_asked_at: new Date().toISOString() })
          .eq('id', guardianId);
        if (revErr) {
          console.warn('[thankyou-mail] failed to mark review-asked for', guardianId, revErr.message);
        }
      }

      const noteBits: string[] = [];
      if (groupReservations.length > 1) noteBits.push(`grouped=${groupReservations.length}`);
      noteBits.push(isFirstVisit ? 'first' : 'repeat');
      if (showReviewCta) noteBits.push('review-cta');
      if (showSurveyCta) noteBits.push('survey-cta');
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
      console.warn('[thankyou-mail] failed for group', groupReservations.map((r: any) => r.id), e);
    }
  }

      // note: 送信 0 件の時に「なぜ 0 か」がパネルから見えるよう理由を付ける。
      let note: string | undefined;
      if (sent === 0 && total === 0 && alreadySent > 0) {
        note = `候補 ${alreadySent} 件は全て送信済み`;
      } else if (sent === 0 && total === 0 && alreadySent === 0) {
        note = '対象予約なし';
      }

      // メール送信は成功したが flag UPDATE に失敗した group が 1 つでも
      // あれば、cron 全体を error 扱いにする (次回 cron で同じ保護者に
      // 再送されるリスクを admin パネルの赤バッジで気付けるようにする)。
      // Resend Idempotency-Key で二重送信自体は Resend 側で防止済みだが、
      // DB flag 不整合は cron_runs に必ず error として記録する。
      if (flagUpdateErrors.length > 0) {
        const failedGroupIds = flagUpdateErrors.flatMap((e) => e.groupIds);
        const okCount = sent - failedGroupIds.length;
        throw new Error(
          `[thankyou-mail] mail-sent but flag-update FAILED for ${flagUpdateErrors.length} ` +
          `group(s) covering ${failedGroupIds.length} reservation(s). ` +
          `Resend Idempotency-Key prevents actual re-send within 24h. ` +
          `Success: sent=${okCount}. Failed reservation IDs: [${failedGroupIds.join(',')}]. ` +
          `First DB error: ${flagUpdateErrors[0].error}`
        );
      }
      return {
        date: targetDate, total, sent, skipped, failed, already_sent: alreadySent, note, details,
        ...(previewOnly ? { preview: true, previews } : {}),
        ...(testTo ? { test_to: testTo } : {}),
        ...(testGuardianId ? { test_guardian_id: testGuardianId } : {}),
      };
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

function addDaysJst(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d) - 9 * 3600 * 1000;
  const next = new Date(base + days * 86400 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(next);
}

/**
 * そのスロットは既に終了時刻を過ぎているか (JST 判定)。
 * end_time が未設定なら start_time + 90 分をフォールバック目安にする。
 * どちらも解釈できなければ「未終了扱い」で安全側に倒す。
 * end_time は "HH:MM" or "HH:MM:SS" 想定。
 */
function isSlotFinishedJst(date: string, endTime: string | null, startTime: string | null): boolean {
  const nowJstMs = Date.now(); // 現在の absolute time
  const endMs = jstDateTimeToUtcMs(date, endTime) ?? (() => {
    const startMs = jstDateTimeToUtcMs(date, startTime);
    return startMs != null ? startMs + 90 * 60 * 1000 : null;
  })();
  if (endMs == null) return false; // どちらも取れなければ「まだ」扱いで送らない
  return nowJstMs >= endMs;
}

/**
 * "2026-08-29" + "10:50" (JST 時刻) を絶対時刻 (UTC ms epoch) に変換。
 * JST は UTC+9 固定なので単純に -9h してから Date.UTC する。
 */
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
  // JST の hh:mm:ss を UTC epoch ms に。JST = UTC + 9h。
  return Date.UTC(y, mo, d, hh - 9, mm, ss);
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

// メール本文を組み立てる (preview でも実送信でも同じ結果にするため共通化)。
function buildThankyouBodyForPreview(args: {
  to: string;
  guardianName: string;
  attendedCourses: Array<{ courseName: string; childNames: string[] }>;
  children: Participant[];
  surveyUrl: string;
  googleReviewUrl: string;
  origin: string;
}): { subject: string; text: string; html: string } {
  const subject = `本日はご参加ありがとうございました！ — 福岡キッズカートアカデミー`;

  // 本日の参加実績 (コース名ごとに子を列挙)
  const attendedLines = args.attendedCourses.map(
    (c) => `  ・${c.courseName} (${c.childNames.join('、')})`
  );

  const text = [
    `${args.guardianName} 様`,
    '',
    '本日は福岡キッズカートアカデミーにお越しいただき、',
    '誠にありがとうございました。',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ 本日の参加実績',
    '━━━━━━━━━━━━━━━━━━━━',
    ...attendedLines,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '▼ お子さまごとの次回のご案内',
    '━━━━━━━━━━━━━━━━━━━━',
    ...args.children.flatMap((p) => [
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
    ...(args.googleReviewUrl ? [
      '━━━━━━━━━━━━━━━━━━━━',
      '⭐ Google でご感想をお聞かせください',
      '━━━━━━━━━━━━━━━━━━━━',
      'お子さまに楽しんでいただけましたら、',
      'Google 上でご感想をお聞かせいただけると嬉しいです。',
      '同じような親御さんのお店選びの助けになります。',
      '',
      `▶ ${args.googleReviewUrl}`,
      '',
    ] : []),
    ...(args.surveyUrl ? [
      '（運営への改善ご要望はこちらのフォームから：）',
      `  ${args.surveyUrl}`,
      '',
    ] : []),
    '━━━━━━━━━━━━━━━━━━━━',
    '福岡キッズカートアカデミー / エーワンサーキット',
    '✉️ info@kidskart.org',
    '📞 092-927-1177',
    '🌐 https://kidskart.org/',
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  // 「本日の参加実績」= コースごとに「どの子が参加したか」を列挙
  const attendedHtml = `
    <div style="background:rgba(58,169,232,.06);border:1px solid rgba(58,169,232,.25);border-radius:10px;padding:.8rem 1rem;margin:1rem 0 1.3rem">
      <div style="font-weight:800;color:#1a7fb8;font-size:.9rem;margin-bottom:.4rem">🏁 本日の参加実績</div>
      <ul style="margin:0;padding-left:1.2rem;font-size:.85rem;color:#163048;line-height:1.8">
        ${args.attendedCourses.map((c) =>
          `<li><strong>${escapeHtml(c.courseName)}</strong> (${escapeHtml(c.childNames.join('、'))})</li>`
        ).join('')}
      </ul>
    </div>
  `;

  // 子ごとに 1 ブロックの next_step。
  // 複数枠参加した子でも、最高 skill × 最高 courseKind で決定した 1 案のみ。
  // 下位の提案 (リピート継続等) は secondary ボタンに格納される設計。
  const participantsHtml = args.children.map((p) => `
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

  // 初回参加者向け Google 口コミ CTA (メイン)。集客に直接効くので優先。
  // Google ポリシー準拠: 全員に同じ導線 (満足者だけ振り分けをしない)。
  const reviewHtml = args.googleReviewUrl ? `
    <div style="background:linear-gradient(135deg,rgba(255,201,67,.15),rgba(255,138,61,.08));border:2px solid #ffc943;border-radius:12px;padding:1.15rem 1rem;margin:1.3rem 0 .3rem;text-align:center">
      <div style="font-size:1.4rem;margin-bottom:.2rem">⭐️⭐️⭐️⭐️⭐️</div>
      <div style="font-weight:800;color:#163048;font-size:1.02rem;margin-bottom:.4rem">Google でご感想をお聞かせください</div>
      <p style="font-size:.82rem;color:#3d556f;margin:0 0 .9rem;line-height:1.65">
        お子さまに楽しんでいただけましたら、<br>
        Google 上でひとことご感想をお願いします。<br>
        <span style="font-size:.72rem;color:#7d8fa0">同じ年頃のお子さまをお持ちの親御さんの<br>お店選びの助けになります</span>
      </p>
      <p style="margin:0">
        <a href="${escapeAttr(args.googleReviewUrl)}" style="display:inline-block;padding:.7rem 1.4rem;background:linear-gradient(135deg,#4285f4,#1a73e8);color:#fff;text-decoration:none;border-radius:8px;font-weight:800;font-size:.9rem;box-shadow:0 3px 10px rgba(66,133,244,.35)">Google に口コミを書く</a>
      </p>
    </div>
  ` : '';

  // 内部アンケート (Google Form) は Google 口コミより控えめに表示。
  // 「改善点収集」用で、集客より運営品質のフィードバック目的。
  const surveyHtml = args.surveyUrl ? `
    <p style="text-align:center;font-size:.72rem;color:#7d8fa0;margin:.2rem 0 1.3rem;line-height:1.6">
      運営への改善ご要望は<a href="${escapeAttr(args.surveyUrl)}" style="color:#1a7fb8;text-decoration:underline;font-weight:700">こちらのフォーム</a>からお寄せください
    </p>
  ` : '';

  const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:'Hiragino Maru Gothic ProN','Hiragino Sans',sans-serif;color:#163048;line-height:1.7;margin:0;padding:1.5rem;background:#f4f9fc">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem 1.3rem;border:1px solid #d8e6f0">
    <div style="text-align:center;font-size:2rem;margin-bottom:.4rem">🎉</div>
    <h2 style="text-align:center;margin:0 0 .5rem;font-size:1.15rem">本日はご参加ありがとうございました！</h2>
    <p style="text-align:center;margin:0 0 1.2rem;color:#3d556f;font-size:.88rem">${escapeHtml(args.guardianName)} 様</p>

    <p style="font-size:.88rem;color:#163048;line-height:1.7;margin:0 0 .5rem">
      本日は福岡キッズカートアカデミーにお越しいただき、誠にありがとうございました。
    </p>

    ${attendedHtml}

    <div style="background:rgba(255,201,67,.08);border-top:2px solid #ffc943;border-bottom:2px solid #ffc943;padding:.7rem;margin:1.2rem 0 1rem;text-align:center">
      <div style="font-weight:800;color:#e5631a;font-size:.95rem">▼ お子さまごとの次回のご案内</div>
    </div>

    ${participantsHtml}

    ${reviewHtml}
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

  return { subject, text, html };
}

async function sendThankyouEmail(env: Env, args: {
  to: string;
  guardianName: string;
  attendedCourses: Array<{ courseName: string; childNames: string[] }>;
  children: Participant[];
  surveyUrl: string;
  googleReviewUrl: string;
  origin: string;
  /**
   * Resend Idempotency-Key。同一 key の再送信リクエストは Resend 側で
   * dedup され、実際にはメールが飛ばない (24h 保持)。
   * 「メール送信成功 → DB flag UPDATE 失敗 → 次日 cron 再抽出」
   * の二重送信を Resend レイヤで防ぐ safety net。
   */
  idempotencyKey?: string;
}) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[thankyou-mail] SKIP send: RESEND_API_KEY not set');
    return;
  }

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';
  const replyTo = env.MAIL_REPLY_TO || undefined;

  const { subject, text, html } = buildThankyouBodyForPreview({
    to: args.to,
    guardianName: args.guardianName,
    attendedCourses: args.attendedCourses,
    children: args.children,
    surveyUrl: args.surveyUrl,
    googleReviewUrl: args.googleReviewUrl,
    origin: args.origin,
  });

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
