import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { keepAlive, originOf, str, mapRpcError, notConfigured } from '@lib/api';
import { sendMail } from '@lib/mail';
import { jaDate } from '@lib/domain';

export const prerender = false;

// POST /api/admin/broadcast
// 天候等で営業状況が変わったときの一括連絡 (仕様 8)。
// その日の「生きている」予約者全員にメールを送る。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const date = str(body?.date);
  const subject = str(body?.subject);
  const message = str(body?.body);
  if (!date || !subject || !message) {
    return json({ error: '日付・件名・本文はすべて必要です' }, 400);
  }

  const { data: rows, error } = await supabase
    .from('aone_reservations')
    .select('id,contact_name,contact_email,reservation_number,kind,access_token')
    .eq('date', date)
    .in('status', ['confirmed', 'contact_wait', 'checking', 'completed']);

  if (error) return mapRpcError(error);

  const targets = (rows ?? []).filter((r) => (r.contact_email ?? '').includes('@'));
  const origin = originOf(request);

  const send = (async () => {
    for (const r of targets) {
      const text = [
        `${r.contact_name} 様`,
        '',
        `${jaDate(date)} のご予約についてのお知らせです。`,
        '',
        message,
        '',
        '▼ 最新の営業状況',
        `${origin}/`,
        '',
        '▼ ご予約内容の確認・変更・キャンセル',
        `${origin}/r/${r.access_token}`,
        '',
        `予約番号: ${r.reservation_number}`,
        '',
        '━━━━━━━━━━━━━━━━━━━━',
        env.PUBLIC_SITE_NAME || 'A-ONE サーキット',
        `📞 ${env.PUBLIC_SITE_TEL || '092-927-1177'}`,
        '━━━━━━━━━━━━━━━━━━━━',
      ].join('\n');

      await sendMail(env, {
        to: r.contact_email!, subject, text, kind: 'broadcast', reservationId: r.id,
      });
    }
  })().catch((e) => console.warn('[broadcast] 送信中にエラー', e));

  keepAlive(locals, send);

  await supabase.from('aone_broadcasts').insert({
    date, subject, body: message,
    recipient_count: targets.length,
    created_by: str(body?.actor) ?? 'admin',
  });

  return json({ ok: true, recipients: targets.length, skipped: (rows?.length ?? 0) - targets.length });
};
