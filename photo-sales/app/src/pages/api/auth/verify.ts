import type { APIRoute } from 'astro';
import { consumeLoginToken, createSession, sessionCookie, SESSION_DAYS } from '@lib/auth.ts';
import { getDb, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const f = await request.formData();
  const db = getDb(locals);
  const staffId = await consumeLoginToken(db, String(f.get('t') ?? ''));
  if (!staffId) return redirect('/admin/login?err=1');
  const cookie = await createSession(db, staffId);
  const next = String(f.get('next') ?? '');
  const secure = new URL(request.url).protocol === 'https:';
  return redirect(next.startsWith('/admin') ? next : '/admin',
    { 'set-cookie': sessionCookie(cookie, SESSION_DAYS * 86400, secure) });
};
