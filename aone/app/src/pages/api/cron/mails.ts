import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { originOf, notConfigured } from '@lib/api';
import { addDays, todayJst } from '@lib/domain';
import {
  sendMail, reminderMail, thanksMail, followupMail, pendingCallbackAlertMail,
  MAIL_COLUMNS, type ReservationForMail,
} from '@lib/mail';

export const prerender = false;

// POST /api/cron/mails?type=all|reminder|thanks|followup|callbacks[&date=YYYY-MM-DD]
//
// 仕様 11 の自動メールをまとめて処理する。GitHub Actions の cron から
// 1 日 2 回叩く想定 (朝: リマインド + フォロー / 夕: 当日お礼)。
//   reminder … 翌日のご予約へのリマインド
//   thanks   … 当日のご利用者へのお礼
//   followup … 2 週間前のご利用者への再来場案内
//   callbacks… 折り返し未対応のまま 24 時間たった予約を管理者に通知 (1 日 1 通)
//
// 二重送信は *_mail_sent_at 列で防ぐ。手動で再送したいときは
// 管理画面から該当列をクリアする (または date パラメータで日付指定)。
const LIVE = ['confirmed', 'completed', 'checking'];

const SELECT = MAIL_COLUMNS;

export const POST: APIRoute = async ({ request, url, locals }) => {
  const env = envFrom(locals);

  // 共有シークレットで保護 (未設定なら誰も叩けないように 503)
  if (!env.CRON_SECRET) {
    return json({ error: 'CRON_SECRET が未設定です' }, 503);
  }
  if (request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  const supabase = getSupabaseAdmin(env);
  const origin = originOf(request);
  const type = url.searchParams.get('type') ?? 'all';
  const base = url.searchParams.get('date') || todayJst();

  const result: Record<string, { sent: number; skipped: number; date: string }> = {};

  async function run(
    kind: 'reminder' | 'thanks' | 'followup',
    date: string,
    column: 'reminder_mail_sent_at' | 'thanks_mail_sent_at' | 'followup_mail_sent_at',
    build: (r: ReservationForMail) => { subject: string; text: string },
  ) {
    const { data: rows, error } = await supabase
      .from('aone_reservations')
      .select(SELECT)
      .eq('date', date)
      .in('status', LIVE)
      .is(column, null);

    if (error) {
      console.warn(`[cron/mails] ${kind} の取得に失敗`, error);
      result[kind] = { sent: 0, skipped: 0, date };
      return;
    }

    let sent = 0;
    let skipped = 0;
    for (const r of (rows ?? []) as unknown as ReservationForMail[]) {
      if (!(r.contact_email ?? '').includes('@')) { skipped++; continue; }
      const m = build(r);
      const ok = await sendMail(env, {
        to: r.contact_email!, subject: m.subject, text: m.text, kind, reservationId: r.id,
      });
      if (ok) {
        await supabase.from('aone_reservations')
          .update({ [column]: new Date().toISOString() })
          .eq('id', r.id);
        sent++;
      } else {
        skipped++;
      }
    }
    result[kind] = { sent, skipped, date };
  }

  if (type === 'all' || type === 'reminder') {
    await run('reminder', addDays(base, 1), 'reminder_mail_sent_at',
      (r) => reminderMail(env, r, origin));
  }
  if (type === 'all' || type === 'thanks') {
    await run('thanks', base, 'thanks_mail_sent_at',
      (r) => thanksMail(env, r, origin));
  }
  if (type === 'all' || type === 'followup') {
    await run('followup', addDays(base, -14), 'followup_mail_sent_at',
      (r) => followupMail(env, r, origin));
  }

  // 折り返し未対応の督促 (管理者宛・お客様には送らない)。
  // 朝の回だけ動かす想定なので、1 日 1 通に収まる。
  if (type === 'all' || type === 'callbacks') {
    const hours = Number(url.searchParams.get('hours') ?? '24');
    const { data: stale, error } = await supabase
      .rpc('aone_pending_callbacks', { p_hours: Number.isFinite(hours) ? hours : 24 });

    if (error) {
      console.warn('[cron/mails] 折り返し待ちの取得に失敗', error);
      result.callbacks = { sent: 0, skipped: 0, date: base };
    } else {
      const rows = (stale ?? []) as any[];
      const to = (env.MAIL_ADMIN_TO ?? '').trim();
      if (rows.length === 0 || !to.includes('@')) {
        result.callbacks = { sent: 0, skipped: rows.length, date: base };
      } else {
        const m = pendingCallbackAlertMail(env, rows, origin);
        const ok = await sendMail(env, { to, subject: m.subject, text: m.text, kind: 'admin' });
        result.callbacks = { sent: ok ? 1 : 0, skipped: ok ? 0 : rows.length, date: base };
      }
    }
  }

  return json({ ok: true, base, result });
};
