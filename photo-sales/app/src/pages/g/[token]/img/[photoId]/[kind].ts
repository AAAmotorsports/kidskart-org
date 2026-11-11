import type { APIRoute } from 'astro';
import { customerImageKey } from '@lib/public.ts';
import { getDb, getEnv } from '@lib/env.ts';
export const prerender = false;

// お客様に出す画像は透かし入りのプレビュー/サムネだけ。原本はここからは出ない
export const GET: APIRoute = async ({ locals, params }) => {
  const key = await customerImageKey(getDb(locals), params.token!, params.photoId!, params.kind!);
  const o = key ? await getEnv(locals).PREVIEWS.get(key) : null;
  if (!o) return new Response('not found', { status: 404 });
  return new Response(o.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
};
