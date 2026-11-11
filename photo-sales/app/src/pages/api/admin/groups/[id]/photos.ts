import type { APIRoute } from 'astro';
import { parseUploadMeta, storePhoto } from '@lib/photos.ts';
import { getDb, getEnv, json } from '@lib/env.ts';
export const prerender = false;

// 既にアップロード済みの写真のハッシュ (重複をクライアント側で先に飛ばすため)
export const GET: APIRoute = async ({ locals, params }) => {
  const rows = (await getDb(locals).prepare(
    `SELECT sha256 FROM photos WHERE group_id = ? AND status <> 'deleted'`).bind(params.id!).all<{ sha256: string }>()).results;
  return json({ hashes: rows.map((r) => r.sha256) });
};

// 写真 1 枚 = 原本 + プレビュー + サムネ を連結したボディ。何度送っても安全 (sha256 で重複は無視)
export const POST: APIRoute = async ({ request, locals, params }) => {
  const db = getDb(locals);
  const group = await db.prepare(`SELECT id FROM groups WHERE id = ? AND status <> 'deleted'`).bind(params.id!).first();
  if (!group) return json({ error: 'group_not_found' }, 404);
  const body = await request.arrayBuffer();
  const meta = parseUploadMeta(request.headers.get('x-photo-meta'), body.byteLength);
  if (typeof meta === 'string') return json({ error: meta }, 400);
  const r = await storePhoto(getEnv(locals), db, params.id!, meta, body);
  return r.status === 'invalid' ? json({ error: 'invalid_image' }, 400) : json(r);
};
