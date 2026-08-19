import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, isEmail, notConfigured } from '@lib/api';
import { sendMail, confirmMail, adminNoticeMail, type ReservationForMail } from '@lib/mail';

export const prerender = false;

// POST /api/reserve/create
//
// Web からの予約受付。受付可否の判定・顧客の名寄せ・INSERT は
// すべて DB 関数 aone_create_reservation() が 1 トランザクションで行う
// (日付単位の advisory lock 付き)。ここは入力の整形とメール送信だけ。
//
// body:
// {
//   kind: 'sport'|'rp'|'charter'|'night',
//   date, session?, category_code?, start_time?, end_time?,
//   party_size, vehicle_count?,
//   name, kana?, phone, email,
//   preferred_contact?, request_note?, terms_agreed?
// }
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

  const kind = str(body?.kind);
  const date = str(body?.date);
  const name = str(body?.name);
  const email = str(body?.email);
  const phone = str(body?.phone);

  if (!kind || !['sport', 'rp', 'charter', 'night'].includes(kind)) {
    return json({ error: '予約種別が不正です' }, 400);
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: '日付を選択してください' }, 400);
  }
  if (!name) return json({ error: 'お名前を入力してください' }, 400);
  if (!phone) return json({ error: 'お電話番号を入力してください' }, 400);
  if (!isEmail(email)) return json({ error: 'メールアドレスをご確認ください' }, 400);

  // RP・貸切はキャンセル規定への同意が必須 (仕様 9)
  if ((kind === 'rp' || kind === 'charter') && body?.terms_agreed !== true) {
    return json({ error: 'キャンセル規定へのご同意が必要です' }, 400);
  }

  const supabase = getSupabaseAdmin(env);
  const { data, response } = await callRpc(supabase, 'aone_create_reservation', {
    kind,
    date,
    session: str(body?.session),
    category_code: str(body?.category_code),
    start_time: str(body?.start_time),
    end_time: str(body?.end_time),
    party_size: Number(body?.party_size) || 1,
    vehicle_count: body?.vehicle_count ? Number(body.vehicle_count) : null,
    contact: { name, kana: str(body?.kana), phone, email },
    preferred_contact: str(body?.preferred_contact),
    source: 'web',
    request_note: str(body?.request_note),
    terms_agreed: body?.terms_agreed === true,
  });
  if (response) return response;

  // ---- メール送信 (レスポンス後も Worker を生かして送る) ----
  const origin = originOf(request);
  const forMail: ReservationForMail = {
    id: data.id,
    reservation_number: data.reservation_number,
    kind: data.kind,
    status: data.status,
    date: data.date,
    session: data.session,
    start_time: data.start_time,
    end_time: data.end_time,
    category_code: data.category_code,
    party_size: data.party_size,
    contact_name: name,
    contact_email: email,
    contact_phone: phone,
    access_token: data.access_token,
  };

  const mails = (async () => {
    const c = confirmMail(env, forMail, origin);
    const sent = await sendMail(env, {
      to: email, subject: c.subject, text: c.text, kind: 'confirm', reservationId: data.id,
    });
    if (sent) {
      await supabase.from('aone_reservations')
        .update({ confirm_mail_sent_at: new Date().toISOString() })
        .eq('id', data.id);
    }
    const adminTo = env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO;
    if (adminTo) {
      const a = adminNoticeMail(env, forMail, origin);
      await sendMail(env, {
        to: adminTo, subject: a.subject, text: a.text, kind: 'admin', reservationId: data.id,
      });
    }
  })().catch((e) => console.warn('[reserve/create] メール送信に失敗', e));

  keepAlive(locals, mails);

  return json({
    ok: true,
    id: data.id,
    reservation_number: data.reservation_number,
    status: data.status,
    access_token: data.access_token,
    message: data.check?.message ?? '',
  });
};
