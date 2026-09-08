import { defineMiddleware } from 'astro:middleware';
import { ADMIN_COOKIE, readCookie, verifySession, passwordOk, safeEqual } from '@lib/adminAuth';

// /admin/* と /api/admin/* を守る。
//
// ★ ブラウザの Basic 認証ダイアログは出さない。あれはパスワードマネージャーの
//   保存対象にならず、スタッフが毎回打つことになる (2026-09 オーナー指摘)。
//   ふつうのログインフォーム (/admin/login) に飛ばし、合言葉は署名付き Cookie。
//   Authorization: Basic は**受け付けるだけ**残してある (手元のスクリプト用)。
//   受け付けるだけで、こちらから WWW-Authenticate を返さないのでダイアログは出ない。
export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // ログインの入口そのものは素通りさせる (でないと入れない)
  if (path === '/admin/login' || path === '/api/login') return next();

  const needsAuth =
    path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/admin/');
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

  // ふだんの経路: ログイン済みの Cookie
  const cookie = readCookie(context.request, ADMIN_COOKIE);
  if (cookie && await verifySession(cookie, passHash)) return next();

  // 手元のスクリプト用。ダイアログを出させないため、こちらからは要求しない
  const header = context.request.headers.get('authorization') ?? '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const decoded = atob(match[1]);
      const idx = decoded.indexOf(':');
      const u = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const p = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (safeEqual(u, user) && await passwordOk(p, passHash)) return next();
    } catch {
      // 壊れたヘッダは無いものとして扱う
    }
  }

  // API は画面を返しても意味がないので JSON で断る。
  // 画面はログインへ送り、戻り先を持たせる (押した先が開けるように)
  if (path.startsWith('/api/admin/')) {
    return new Response(JSON.stringify({ error: 'ログインしてください' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const next_ = encodeURIComponent(path + url.search);
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/login?next=${next_}` },
  });
});
