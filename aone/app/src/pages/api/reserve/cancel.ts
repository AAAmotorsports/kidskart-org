import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, notConfigured } from '@lib/api';
import { sendMail, cancelMail, type ReservationForMail } from '@lib/mail';

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

  const { data: row } = await supabase
    .from('aone_reservations')
    .select('id,reservation_number,kind,status,date,session,start_time,end_time,category_code,party_size,contact_name,contact_email,contact_phone,access_token,amount')
    .eq('id', data.id)
    .single();

  if (row?.contact_email) {
    const m = cancelMail(env, row as unknown as ReservationForMail, originOf(request), !!data.cancel_fee);
    keepAlive(
      locals,
      sendMail(env, {
        to: row.contact_email, subject: m.subject, text: m.text,
        kind: 'cancel', reservationId: data.id,
      }),
    );
  }

  return json({ ok: true, ...data });
};
