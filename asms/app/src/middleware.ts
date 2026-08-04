import { defineMiddleware } from 'astro:middleware';

// HTTP Basic Auth guard for /admin/* and /api/admin/*
// This is an MVP measure. Replace with Supabase Auth session cookies
// once the login flow is implemented.
export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const needsAuth =
    url.pathname === '/admin' ||
    url.pathname.startsWith('/admin/') ||
    url.pathname.startsWith('/api/admin/');

  if (!needsAuth) return next();

  // Cloudflare Workers exposes bindings through context.locals.runtime.env.
  // In dev (`astro dev`) they land on import.meta.env instead. Read both
  // so the same middleware works in both worlds.
  const rt = (context.locals as any)?.runtime?.env;
  const user = rt?.ADMIN_USERNAME || import.meta.env.ADMIN_USERNAME || '';
  const pass = rt?.ADMIN_PASSWORD || import.meta.env.ADMIN_PASSWORD || '';

  if (!user || !pass) {
    // Debug output so we can see exactly what env surface the Worker has.
    // Once auth works this branch is never hit in production so the leak
    // window is short — but still: only reveal key NAMES, never values.
    const rtKeys = rt ? Object.keys(rt).slice(0, 30).sort() : [];
    const metaKeys = Object.keys(import.meta.env)
      .filter((k) => !k.startsWith('_'))
      .slice(0, 30)
      .sort();
    const body = [
      'Admin credentials are not configured.',
      '',
      'Set ADMIN_USERNAME (plain) and ADMIN_PASSWORD (secret) as',
      'Worker runtime variables in Cloudflare Dashboard.',
      '',
      '--- DEBUG (env surface visible to the middleware) ---',
      `context.locals.runtime.env present: ${!!rt}`,
      `runtime.env keys (${rtKeys.length}): ${JSON.stringify(rtKeys)}`,
      `import.meta.env keys (${metaKeys.length}): ${JSON.stringify(metaKeys)}`,
      `ADMIN_USERNAME resolved length: ${user.length}`,
      `ADMIN_PASSWORD resolved length: ${pass.length}`,
    ].join('\n');
    return new Response(body, {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const header = context.request.headers.get('authorization') ?? '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const decoded = atob(match[1]);
      const idx = decoded.indexOf(':');
      const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const p = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (safeEqual(u, user) && safeEqual(p, pass)) {
        return next();
      }
    } catch {
      // fall through to 401
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="ASMS admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
