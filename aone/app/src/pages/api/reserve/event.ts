import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, notConfigured } from '@lib/api';
import { sendMail, entryMail, adminEntryMail, ENTRY_COLUMNS_MAIL, type EntryForMail } from '@lib/mail';

export const prerender = false;

// POST /api/reserve/event
//
// イベントの参加申込 (エントリー)。走行の予約とは別台帳。
// 受付可否の判定は DB 側 (aone_create_event_entry) が持つ。
// ここは入力を渡してメールを送るだけで、ルールを再実装しない。
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

  const supabase = getSupabaseAdmin(env);
  const { data, response } = await callRpc(supabase, 'aone_create_event_entry', {
    block_id: str(body?.block_id),
    team_name: str(body?.team_name),
    frame_maker: str(body?.frame_maker),
    number_wish: str(body?.number_wish),
    race_class: str(body?.race_class),
    note: str(body?.note),
    agreed: body?.agreed === true,
    source: 'web',
    contact: {
      name: str(body?.name),
      kana: str(body?.kana),
      email: str(body?.email),
      phone: str(body?.phone),
    },
  });
  if (response) return response;

  // 控えを送る。走行の予約と違い、参加案内・当日の集合時間などを
  // あとから個別に送ることになるので、まずは受け付けた事実を残す。
  const { data: raw } = await supabase
    .from('aone_event_entries')
    .select(ENTRY_COLUMNS_MAIL)
    .eq('id', data.id)
    .maybeSingle();
  const row = raw as unknown as EntryForMail | null;
  const origin = originOf(request);

  if (row) {
    const send = (async () => {
      await sendMail(env, { to: row.contact_email, ...entryMail(env, row, origin), kind: 'confirm' });
      const admin = (env.MAIL_ADMIN_TO || env.MAIL_REPLY_TO || '').trim();
      if (admin.includes('@')) {
        await sendMail(env, { to: admin, ...adminEntryMail(env, row, origin), kind: 'admin' });
      }
    })().catch((e) => console.warn('[reserve/event] メール送信に失敗', e));
    keepAlive(locals, send);
  }

  return json(data, 200);
};
