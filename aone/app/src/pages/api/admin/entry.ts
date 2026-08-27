import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { callRpc, str, mapRpcError, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/entry
//
// イベント参加申込の管理操作。確定 / 入金記録 / メモ / 取り消し。
//
// お客様への「参加のご案内」は定型化できない (集合時間・組み合わせ・
// レンタル車両の割り当てが毎回違う) ので、自動送信はしない。
// 連絡が要るときは /admin/entries から電話・メールで個別に送る運用。
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

  const id = str(body?.id);
  if (!id) return json({ error: 'id が必要です' }, 400);

  // 取り消しは記録を消さずに status を倒す (誰から何を受けたかは残す)
  if (body?.cancel === true) {
    const { data, response } = await callRpc(supabase, 'aone_cancel_event_entry', {
      id, reason: str(body?.reason),
    });
    return response ?? json(data, 200);
  }

  // 送られてきた項目だけを触る。1 つのボタンが他の項目を巻き添えにしない
  const patch: Record<string, unknown> = {};
  if ('status' in body) {
    const status = str(body.status);
    if (!status || !['received', 'confirmed'].includes(status)) {
      return json({ error: '状態が不正です' }, 400);
    }
    patch.status = status;
  }
  if ('is_paid' in body) patch.is_paid = body.is_paid === true;
  if ('staff_memo' in body) patch.staff_memo = str(body.staff_memo) ?? null;
  if ('amount' in body) {
    const raw = str(body.amount);
    patch.amount = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  }

  if (Object.keys(patch).length === 0) {
    return json({ error: '変更する項目がありません' }, 400);
  }

  const { error } = await supabase.from('aone_event_entries').update(patch).eq('id', id);
  if (error) return mapRpcError(error);
  return json({ ok: true });
};
