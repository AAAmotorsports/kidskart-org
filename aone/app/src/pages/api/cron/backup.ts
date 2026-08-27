import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { notConfigured } from '@lib/api';
import { reservationsCsv, customersCsv, entriesCsv } from '@lib/csv';
import { sendMail } from '@lib/mail';
import { jaDate, todayJst } from '@lib/domain';

export const prerender = false;

// POST /api/cron/backup
//
// 予約台帳と顧客名簿を CSV にして、管理者宛にメールで送る (月 1 回)。
//
// Supabase の無料プランには自動バックアップが無い。予約台帳と顧客名簿が
// 飛ぶと業務が止まるので、毎月 1 日に受信箱へ控えを置く。メールボックスが
// そのまま保管場所になるので、誰かが手作業を思い出す必要がない。
//
// GitHub Actions の .github/workflows/aone-backup.yml から叩く。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);

  if (!env.CRON_SECRET) return json({ error: 'CRON_SECRET が未設定です' }, 503);
  if (request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  const to = (env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO || '').trim();
  if (!to.includes('@')) {
    return json({ error: 'MAIL_ADMIN_TO が未設定です' }, 503);
  }

  const supabase = getSupabaseAdmin(env);
  let reservations;
  let customers;
  let entries;
  try {
    [reservations, customers, entries] = await Promise.all([
      reservationsCsv(supabase),
      customersCsv(supabase),
      entriesCsv(supabase),
    ]);
  } catch (e: any) {
    console.warn('[cron/backup] CSV の作成に失敗', e);
    return json({ error: String(e?.message ?? e) }, 500);
  }

  // ヘッダー行を除いた件数
  const count = (csv: string) => Math.max(csv.trimEnd().split('\r\n').length - 1, 0);
  const today = todayJst();

  const ok = await sendMail(env, {
    to,
    subject: `【控え】A-ONE 予約台帳・顧客名簿・参加申込 ${today}`,
    text: [
      `${jaDate(today)} 時点の控えです。`,
      '',
      `・予約台帳 ${count(reservations.body)} 件`,
      `・顧客名簿 ${count(customers.body)} 名`,
      `・参加申込 ${count(entries.body)} 件`,
      '',
      '添付の CSV は Excel や Numbers でそのまま開けます。',
      'このメールを消さずに残しておけば、万一のときにここから戻せます。',
      '',
      '※ 個人情報を含みます。転送や共有にはご注意ください。',
    ].join('\n'),
    kind: 'admin',
    attachments: [
      { filename: reservations.filename, content: reservations.body },
      { filename: customers.filename, content: customers.body },
      { filename: entries.filename, content: entries.body },
    ],
  });

  return json({
    ok,
    date: today,
    reservations: count(reservations.body),
    customers: count(customers.body),
    entries: count(entries.body),
  }, ok ? 200 : 500);
};
