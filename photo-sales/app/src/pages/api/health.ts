import type { APIRoute } from 'astro';
export const prerender = false;
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ ok: true, app: 'aone-photo' }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
