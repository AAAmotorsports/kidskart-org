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

  const rt = (context.locals as any)?.runtime?.env ?? import.meta.env;
  const user = rt.ADMIN_USERNAME as string | undefined;
  const pass = rt.ADMIN_PASSWORD as string | undefined;

  // If admin credentials are not configured at all, block outright.
  if (!user || !pass) {
    return new Response(
      'Admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in the Worker environment.',
      { status: 503 }
    );
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

// Constant-time-ish string compare to blunt timing attacks.
// Not perfect (length is leaked) but good enough for a shared secret.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
