import type { APIRoute } from 'astro';
import { tvImageKey } from '@lib/public.ts';
import { getDb, getEnv } from '@lib/env.ts';
export const prerender = false;

// テレビには透かし入り・低解像度のプレビューだけ (tv_ok の団体のみ)
export const GET: APIRoute = async ({ locals, params }) => {
  const key = await tvImageKey(getDb(locals), params.token!, params.photoId!);
  const o = key ? await getEnv(locals).PREVIEWS.get(key) : null;
  if (!o) return new Response('not found', { status: 404 });
  return new Response(o.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400, immutable' } });
};
