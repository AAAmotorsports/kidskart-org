import { defineMiddleware } from 'astro:middleware';
import { staffFromCookie } from './lib/auth.ts';
import { getDb } from './lib/env.ts';

// ログイン前に開けるスタッフ画面
const OPEN_ADMIN = new Set(['/admin/login', '/admin/verify']);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const t0 = performance.now();
  const { request } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';

  // CSRF: 書き込み系は同一オリジンからのみ (Stripe Webhook は別途署名検証するので除外)
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && path !== '/api/stripe/webhook') {
    const origin = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    let ok: boolean;
    if (origin && origin !== 'null') {
      try { ok = new URL(origin).host === url.host; } catch { ok = false; }
    } else {
      // Origin が無い / 'null' (referrer-policy 次第でブラウザが 'null' を送る) → Fetch Metadata で判定
      ok = site === null || site === 'same-origin' || site === 'none';
    }
    if (!ok) return new Response('forbidden', { status: 403 });
  }

  const isAdminPage = path === '/admin' || path.startsWith('/admin/');
  const isAdminApi = path.startsWith('/api/admin');
  if ((isAdminPage || isAdminApi) && !OPEN_ADMIN.has(path)) {
    const staff = await staffFromCookie(getDb(ctx.locals), request.headers.get('cookie'));
    if (!staff) {
      if (isAdminApi) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return new Response(null, { status: 302, headers: { location: `/admin/login?next=${encodeURIComponent(path + url.search)}` } });
    }
    ctx.locals.staff = staff;
  }

  const res = await next();
  const h = new Headers(res.headers);
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'same-origin');   // 他サイトへはトークン入りの URL を漏らさない。同一サイトの POST は Origin を送れる
  h.set('x-robots-tag', 'noindex, nofollow');
  h.set('x-frame-options', 'DENY');
  if (isAdminPage || isAdminApi || path.startsWith('/api/auth')) h.set('cache-control', 'no-store');
  h.set('server-timing', `app;dur=${(performance.now() - t0).toFixed(1)}`);   // S1 (CPU 計測) の目安
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
});
