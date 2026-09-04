import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, keepAlive, originOf, str, mapRpcError, notConfigured } from '@lib/api';
import { sendMail, confirmMail, cancelMail, changeMail, MAIL_COLUMNS, type ReservationForMail } from '@lib/mail';

export const prerender = false;

// POST /api/admin/reservation   (Basic 認証は middleware で担保)
//
// スタッフの代理入力・強制操作をすべてここで受ける (仕様 13 / 15)。
//   action = 'create'  電話・店頭予約の代理入力 (forced で枠を無視できる)
//            'update'  日時・人数・カテゴリーの変更 (forced 可)
//            'cancel'  キャンセル / 無断キャンセル記録
//            'status'  受付 → 連絡待ち → 確認中 → 確定 → 完了 の遷移
//            'memo'    スタッフメモ・タグ・料金・入金の更新
//            'contacted' 折り返し対応の記録 (undo: true で取り消し)
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

  const action = str(body?.action) ?? 'create';
  const actor = str(body?.actor) ?? 'admin';

  if (action === 'create') {
    const { data, response } = await callRpc(supabase, 'aone_create_reservation', {
      kind: str(body?.kind),
      date: str(body?.date),
      session: str(body?.session),
      category_code: str(body?.category_code),
      night_kind: str(body?.night_kind),
      start_time: str(body?.start_time),
      end_time: str(body?.end_time),
      party_size: Number(body?.party_size) || 1,
      vehicle_count: body?.vehicle_count ? Number(body.vehicle_count) : null,
      contact: {
        name: str(body?.name),
        kana: str(body?.kana),
        phone: str(body?.phone),
        email: str(body?.email),
      },
      preferred_contact: str(body?.preferred_contact),
      source: str(body?.source) ?? 'phone',
      request_note: str(body?.request_note),
      staff_memo: str(body?.staff_memo),
      amount: body?.amount ? Number(body.amount) : null,
      status: str(body?.status),
      forced: body?.forced === true,
      forced_reason: str(body?.forced_reason),
      created_by: actor,
      terms_agreed: true, // 電話口・店頭で口頭確認した前提
    });
    if (response) return response;

    // メールアドレスがあり、かつ送信を希望した場合のみ控えを送る
    if (body?.send_mail === true && str(body?.email)) {
      const forMail: ReservationForMail = {
        id: data.id,
        reservation_number: data.reservation_number,
        kind: data.kind,
        status: data.status,
        date: data.date,
        session: data.session,
        start_time: data.start_time,
        end_time: data.end_time,
        party_size: data.party_size,
        contact_name: str(body?.name) ?? '',
        contact_email: str(body?.email),
        access_token: data.access_token,
      };
      const m = confirmMail(env, forMail, originOf(request));
      keepAlive(locals, sendMail(env, {
        to: forMail.contact_email!, subject: m.subject, text: m.text,
        kind: 'confirm', reservationId: data.id,
      }));
    }

    return json({ ok: true, ...data });
  }

  if (action === 'update') {
    const { data, response } = await callRpc(supabase, 'aone_update_reservation', {
      id: str(body?.id),
      date: str(body?.date),
      session: str(body?.session),
      category_code: str(body?.category_code),
      night_kind: str(body?.night_kind),
      start_time: str(body?.start_time),
      end_time: str(body?.end_time),
      party_size: body?.party_size ? Number(body.party_size) : null,
      vehicle_count: body?.vehicle_count ? Number(body.vehicle_count) : null,
      request_note: str(body?.request_note),
      staff_memo: str(body?.staff_memo),
      amount: body?.amount ? Number(body.amount) : null,
      contact: {
        name: str(body?.name),
        kana: str(body?.kana),
        phone: str(body?.phone),
        email: str(body?.email),
      },
      forced: body?.forced !== false, // 管理画面からの変更は既定で強制
      actor,
    });
    if (response) return response;

    // 電話で受けたあとにメールアドレスを聞けることがある。予約だけに入れると
    // 顧客名簿は空のままになるので、**空欄のときだけ** 顧客側にも入れる。
    // 別の値が入っているときは上書きしない (スタッフが直した表記を潰さない)
    const newEmail = (str(body?.email) ?? '').trim().toLowerCase();
    const newPhone = (str(body?.phone) ?? '').trim();
    if (newEmail || newPhone) {
      const { data: res } = await supabase
        .from('aone_reservations').select('customer_id').eq('id', str(body?.id)).maybeSingle();
      const customerId = (res as any)?.customer_id;
      if (customerId) {
        const { data: cus } = await supabase
          .from('aone_customers').select('email,phone').eq('id', customerId).maybeSingle();
        const patch: Record<string, string> = {};
        if (newEmail && !((cus as any)?.email ?? '').trim()) patch.email = newEmail;
        if (newPhone && !((cus as any)?.phone ?? '').trim()) patch.phone = newPhone;
        if (Object.keys(patch).length > 0) {
          const { error: cerr } = await supabase
            .from('aone_customers').update(patch).eq('id', customerId);
          // 顧客名簿に入らなくても予約の変更は成立している。失敗しても止めない
          if (cerr) console.warn('[admin/reservation] 顧客への反映に失敗', cerr.message);
        }
      }
    }

    // スタッフが変更したときは、お客様に知らせるかどうかを画面で選べる
    if (body?.send_mail === true) {
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
    }
    return json({ ok: true, ...data });
  }

  // 「変更をメールで送信」— いま入っている内容をそのまま知らせる。
  // 保存と送信を分けているのは、電話で話しながら何度も直すことがあり、
  // そのたびにメールが飛ぶと困るため (2026-08 オーナー確認)。
  // 予約は一切書き換えない。送るだけ。
  if (action === 'notify') {
    const id = str(body?.id);
    if (!id) return json({ error: 'id が必要です' }, 400);

    const { data: rawRow, error } = await supabase
      .from('aone_reservations').select(MAIL_COLUMNS).eq('id', id).maybeSingle();
    if (error) return mapRpcError(error);
    const row = rawRow as unknown as ReservationForMail | null;
    if (!row) return json({ error: '予約が見つかりません' }, 404);
    if (!(row.contact_email ?? '').includes('@')) {
      return json({ error: 'メールアドレスの登録がありません。お電話でご連絡ください' }, 400);
    }

    const m = changeMail(env, row, originOf(request));
    const ok = await sendMail(env, {
      to: row.contact_email!, subject: m.subject, text: m.text,
      kind: 'confirm', reservationId: id,
    });
    if (!ok) return json({ error: '送信できませんでした (送信ログをご確認ください)' }, 502);
    return json({ ok: true, sent_to: row.contact_email });
  }

  if (action === 'cancel') {
    const { data, response } = await callRpc(supabase, 'aone_cancel_reservation', {
      id: str(body?.id),
      reason: str(body?.reason),
      no_show: body?.no_show === true,
      actor,
    });
    if (response) return response;

    if (body?.send_mail === true && !data.already) {
      // MAIL_COLUMNS は定数なので supabase-js の型推論が効かない。1 か所で受け直す
      const { data: rawRow } = await supabase
        .from('aone_reservations')
        .select(MAIL_COLUMNS)
        .eq('id', data.id)
        .single();
      const row = rawRow as unknown as ReservationForMail | null;
      if (row?.contact_email) {
        const m = cancelMail(env, row, originOf(request), !!data.cancel_fee, data.cancel_fee_rate ?? 100);
        keepAlive(locals, sendMail(env, {
          to: row.contact_email!, subject: m.subject, text: m.text,
          kind: 'cancel', reservationId: data.id,
        }));
      }
    }
    return json({ ok: true, ...data });
  }

  if (action === 'status') {
    const { data, response } = await callRpc(supabase, 'aone_set_reservation_status', {
      id: str(body?.id),
      status: str(body?.status),
      reason: str(body?.reason),
      is_paid: typeof body?.is_paid === 'boolean' ? body.is_paid : null,
      staff_memo: str(body?.staff_memo),
      actor,
    });
    if (response) return response;
    return json({ ok: true, ...data });
  }

  if (action === 'memo') {
    const patch: Record<string, unknown> = {};
    if (body?.staff_memo !== undefined) patch.staff_memo = str(body.staff_memo) ?? null;
    if (Array.isArray(body?.tags)) patch.tags = body.tags.filter((t: unknown) => typeof t === 'string');
    if (body?.amount !== undefined) patch.amount = body.amount === '' ? null : Number(body.amount);
    if (typeof body?.is_paid === 'boolean') patch.is_paid = body.is_paid;

    const { error } = await supabase.from('aone_reservations').update(patch).eq('id', str(body?.id));
    if (error) return mapRpcError(error);
    return json({ ok: true });
  }

  if (action === 'contacted') {
    // 連絡待ち・確認中の予約に「対応した」印を付ける。
    // ステータスは変えない (電話はしたが返事待ち、という状態があるため)。
    const { data, response } = await callRpc(supabase, 'aone_mark_contacted', {
      id: str(body?.id),
      method: str(body?.method),
      result: str(body?.result),
      actor,
      undo: body?.undo === true,
    });
    if (response) return response;
    return json({ ok: true, ...data });
  }

  return json({ error: '不明な操作です' }, 400);
};
