import { defineMiddleware } from 'astro:middleware';

// /admin/* と /api/admin/* を HTTP Basic 認証で保護する。
// パスワードは SHA-256 ダイジェスト (ADMIN_PASSWORD_HASH) で保持し、
// 平文はリポジトリにも Worker にも置かない。
//
// MVP 実装。スタッフごとのログインが必要になったら Supabase Auth に置き換える。
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
    return new Response(
      [
        '管理画面の認証情報が設定されていません。',
        '',
        'ADMIN_USERNAME は wrangler.jsonc の vars に、',
        'ADMIN_PASSWORD_HASH (SHA-256 hex) は Cloudflare Dashboard の',
        'シークレット型に設定してください。',
        "  printf '<newpass>' | sha256sum",
      ].join('\n'),
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
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
      if (safeEqual(u, user) && safeEqual(await sha256Hex(p), passHash.toLowerCase())) {
        return next();
      }
    } catch {
      // fall through to 401
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="A-ONE admin", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
