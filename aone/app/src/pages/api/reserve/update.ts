import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, notConfigured } from '@lib/api';
import { sendMail, changeMail, adminChangeMail, MAIL_COLUMNS, type ReservationForMail } from '@lib/mail';

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

  // 変更前の内容を控えておく (管理者宛に「何がどう変わったか」を出すため)
  const { data: rawBefore } = await supabase
    .from('aone_reservations')
    .select(MAIL_COLUMNS)
    .eq('access_token', token)
    .maybeSingle();
  const before = rawBefore as unknown as ReservationForMail | null;

  const { data, response } = await callRpc(supabase, 'aone_update_reservation', {
    access_token: token,
    date: str(body?.date),
    start_time: str(body?.start_time),
    // 貸切・ナイターは終了時間もお客様が変えられる。
    // ここに書き忘れると、画面では変えられるのに保存されない (2026-09 に発生)
    end_time: str(body?.end_time),
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

  const origin = originOf(request);

  if (row?.contact_email) {
    const m = changeMail(env, row, origin);
    keepAlive(locals, sendMail(env, {
      to: row.contact_email, subject: m.subject, text: m.text,
      kind: 'confirm', reservationId: data.id,
    }));
  }

  // 管理者にも知らせる。席の空きや用意する台数が変わるため
  const adminTo = env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO;
  if (adminTo && before && row) {
    const a = adminChangeMail(env, before, row, origin);
    keepAlive(locals, sendMail(env, {
      to: adminTo, subject: a.subject, text: a.text,
      kind: 'admin', reservationId: data.id,
    }));
  }

  return json({ ok: true, ...data });
};
