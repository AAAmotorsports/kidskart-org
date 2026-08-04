import { defineMiddleware } from 'astro:middleware';

// HTTP Basic Auth guard for /admin/* and /api/admin/*.
// The password is stored as a SHA-256 digest in wrangler.jsonc (via
// ADMIN_PASSWORD_HASH), so the plain value is never committed. On each
// request we hash what the client submits and compare digests.
//
// This is an MVP measure — replace with Supabase Auth session cookies
// once the staff login flow is implemented.
export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const needsAuth =
    url.pathname === '/admin' ||
    url.pathname.startsWith('/admin/') ||
    url.pathname.startsWith('/api/admin/');

  if (!needsAuth) return next();

  const rt = (context.locals as any)?.runtime?.env;
  const user = rt?.ADMIN_USERNAME || import.meta.env.ADMIN_USERNAME || '';
  const passHash = rt?.ADMIN_PASSWORD_HASH || import.meta.env.ADMIN_PASSWORD_HASH || '';

  if (!user || !passHash) {
    const rtKeys = rt ? Object.keys(rt).slice(0, 30).sort() : [];
    const body = [
      'Admin credentials are not configured.',
      '',
      'Expected ADMIN_USERNAME and ADMIN_PASSWORD_HASH in the Worker',
      "runtime env (wrangler.jsonc vars).",
      '',
      '--- DEBUG ---',
      `context.locals.runtime.env present: ${!!rt}`,
      `runtime.env keys (${rtKeys.length}): ${JSON.stringify(rtKeys)}`,
      `ADMIN_USERNAME resolved length: ${user.length}`,
      `ADMIN_PASSWORD_HASH resolved length: ${passHash.length}`,
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
      const submittedHash = await sha256Hex(p);
      if (safeEqual(u, user) && safeEqual(submittedHash, passHash.toLowerCase())) {
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
