import type { APIRoute } from 'astro';
import { getDb, getEnv } from '@lib/env.ts';
export const prerender = false;

// スタッフ用の画像表示 (サムネ / プレビューのみ。原本はここから出さない)
export const GET: APIRoute = async ({ locals, params }) => {
  const kind = params.kind;
  if (kind !== 'thumb' && kind !== 'preview') return new Response('not found', { status: 404 });
  const col = kind === 'thumb' ? 'thumb_key' : 'preview_key';
  const r = await getDb(locals).prepare(`SELECT ${col} AS k FROM photos WHERE id = ? AND status <> 'deleted'`)
    .bind(params.id!).first<{ k: string }>();
  if (!r) return new Response('not found', { status: 404 });
  const o = await getEnv(locals).PREVIEWS.get(r.k);
  if (!o) return new Response('not found', { status: 404 });
  return new Response(o.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
};
