import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { keepAlive, originOf, str, mapRpcError, notConfigured } from '@lib/api';
import { sendMail } from '@lib/mail';
import { jaDate, nameWithHonorific } from '@lib/domain';

export const prerender = false;

// POST /api/admin/broadcast
//
// 営業状況・路面状況が変わったときのお知らせ (仕様 8)。
//
//   reservation_ids なし … その日の「生きている」予約者全員へ (一括連絡)
//   reservation_ids あり … 指定した予約者だけへ (個別連絡)
//
// ★ 営業状況・路面状況を変えただけでは 1 通も飛ばない。ここを人が押したときだけ送る。
//   急な休業は電話で連絡する運用なので、自動送信にはしていない。
//
// 一括も個別も同じ 1 本にしてある。テンプレートを 2 か所に書くと必ず片方が腐る。
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

  // 個別連絡: 宛先を指定した予約だけに絞る
  const only = Array.isArray(body?.reservation_ids)
    ? body.reservation_ids.map((v: unknown) => str(v)).filter(Boolean) as string[]
    : null;
  if (only && only.length === 0) {
    return json({ error: '宛先の予約が指定されていません' }, 400);
  }

  let query = supabase
    .from('aone_reservations')
    .select('id,contact_name,contact_email,reservation_number,kind,access_token')
    .eq('date', date)
    .in('status', ['confirmed', 'contact_wait', 'checking', 'completed']);
  if (only) query = query.in('id', only);

  const { data: rows, error } = await query;

  if (error) return mapRpcError(error);

  const targets = (rows ?? []).filter((r) => (r.contact_email ?? '').includes('@'));
  const origin = originOf(request);

  const send = (async () => {
    for (const r of targets) {
      const text = [
        nameWithHonorific(r.contact_name),
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
        `📞 ${env.PUBLIC_SITE_TEL || '092-919-7186'}`,
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

  // 個別連絡でメールアドレスが無い相手は送れない。呼び出し側で
  // 「電話で連絡してください」と出せるように、はっきり返す。

  return json({ ok: true, recipients: targets.length, skipped: (rows?.length ?? 0) - targets.length });
};
