import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { str, mapRpcError, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/customer
// 顧客のスタッフメモ・タグ更新 (仕様 17)。顧客側には表示しない。
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

  const id = str(body?.id);
  if (!id) return json({ error: 'id が必要です' }, 400);

  const patch: Record<string, unknown> = {};
  if (body?.staff_memo !== undefined) patch.staff_memo = str(body.staff_memo) ?? null;
  if (Array.isArray(body?.tags)) patch.tags = body.tags.filter((t: unknown) => typeof t === 'string');
  if (body?.name !== undefined) patch.name = str(body.name);
  if (body?.kana !== undefined) patch.kana = str(body.kana) ?? null;
  if (body?.phone !== undefined) patch.phone = str(body.phone) ?? null;
  if (body?.email !== undefined) patch.email = (str(body.email) ?? '').toLowerCase() || null;

  const { error } = await getSupabaseAdmin(env).from('aone_customers').update(patch).eq('id', id);
  if (error) return mapRpcError(error);
  return json({ ok: true });
};
