import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, notConfigured } from '@lib/api';
import { sendMail, cancelMail, MAIL_COLUMNS, type ReservationForMail } from '@lib/mail';

export const prerender = false;

// POST /api/reserve/cancel
// 予約者専用ページからのキャンセル (仕様 9 / 10)。
//   連絡さえあれば、当日でも・種別を問わずキャンセル料なし。
//   当日・連絡のないキャンセル (無断キャンセル) のみ料金 100%。
//   このページからのキャンセルは「連絡あり」なので cancel_fee は常に false になる。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const token = str(body?.access_token);
  if (!token) return json({ error: '予約を特定できませんでした' }, 400);

  const supabase = getSupabaseAdmin(env);
  const { data, response } = await callRpc(supabase, 'aone_cancel_reservation', {
    access_token: token,
    reason: str(body?.reason),
    actor: 'customer',
  });
  if (response) return response;

  // MAIL_COLUMNS は定数なので supabase-js の型推論が効かない。1 か所で受け直す
  const { data: rawRow } = await supabase
    .from('aone_reservations')
    .select(MAIL_COLUMNS)
    .eq('id', data.id)
    .single();
  const row = rawRow as unknown as ReservationForMail | null;

  if (row?.contact_email) {
    const m = cancelMail(env, row, originOf(request), !!data.cancel_fee);
    keepAlive(
      locals,
      sendMail(env, {
        to: row.contact_email!, subject: m.subject, text: m.text,
        kind: 'cancel', reservationId: data.id,
      }),
    );
  }

  return json({ ok: true, ...data });
};
