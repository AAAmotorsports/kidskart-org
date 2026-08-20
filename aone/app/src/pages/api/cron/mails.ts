import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { originOf, notConfigured } from '@lib/api';
import { addDays, todayJst } from '@lib/domain';
import {
  sendMail, reminderMail, thanksMail, followupMail, type ReservationForMail,
} from '@lib/mail';

export const prerender = false;

// POST /api/cron/mails?type=all|reminder|thanks|followup[&date=YYYY-MM-DD]
//
// 仕様 11 の自動メールをまとめて処理する。GitHub Actions の cron から
// 1 日 2 回叩く想定 (朝: リマインド + フォロー / 夕: 当日お礼)。
//   reminder … 翌日のご予約へのリマインド
//   thanks   … 当日のご利用者へのお礼
//   followup … 2 週間前のご利用者への再来場案内
//
// 二重送信は *_mail_sent_at 列で防ぐ。手動で再送したいときは
// 管理画面から該当列をクリアする (または date パラメータで日付指定)。
const LIVE = ['confirmed', 'completed', 'checking'];

const SELECT =
  'id,reservation_number,kind,status,date,session,start_time,end_time,category_code,party_size,' +
  'contact_name,contact_email,contact_phone,access_token,amount';

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

  return json({ ok: true, base, result });
};
