import type { APIRoute } from 'astro';
import { destroySession, sessionCookie } from '@lib/auth.ts';
import { getDb, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  await destroySession(getDb(locals), request.headers.get('cookie'));
  return redirect('/admin/login', { 'set-cookie': sessionCookie('', 0, new URL(request.url).protocol === 'https:') });
};
