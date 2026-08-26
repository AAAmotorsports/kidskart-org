import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, notConfigured } from '@lib/api';
import { sendMail, changeMail, MAIL_COLUMNS, type ReservationForMail } from '@lib/mail';

export const prerender = false;

// POST /api/reserve/update
// 予約者専用ページ (/r/[token]) からの変更。仕様 4 / 10。
// 時間・人数はいつでも変更可能で、変更のたびに DB 側が最新の空き状況を再判定する。
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
  const { data, response } = await callRpc(supabase, 'aone_update_reservation', {
    access_token: token,
    date: str(body?.date),
    start_time: str(body?.start_time),
    session: str(body?.session),
    party_size: body?.party_size ? Number(body.party_size) : null,
    vehicle_count: body?.vehicle_count ? Number(body.vehicle_count) : null,
    request_note: str(body?.request_note),
    contact: {
      name: str(body?.name),
      kana: str(body?.kana),
      phone: str(body?.phone),
      email: str(body?.email),
    },
    actor: 'customer',
  });
  if (response) return response;

  // 変更後の内容を控えとして送る。自分で変えた場合でも「今どうなっているか」が
  // 手元に残る方が安心なので、無条件で送る。
  const { data: rawRow } = await supabase
    .from('aone_reservations')
    .select(MAIL_COLUMNS)
    .eq('id', data.id)
    .maybeSingle();
  const row = rawRow as unknown as ReservationForMail | null;

  if (row?.contact_email) {
    const m = changeMail(env, row, originOf(request));
    keepAlive(locals, sendMail(env, {
      to: row.contact_email, subject: m.subject, text: m.text,
      kind: 'confirm', reservationId: data.id,
    }));
  }

  return json({ ok: true, ...data });
};
