import type { APIRoute } from 'astro';
import {
  ADMIN_COOKIE, SESSION_DAYS, cookieHeader, passwordOk, safeEqual, safeNext, signSession,
} from '@lib/adminAuth';

export const prerender = false;

// POST /api/login … 管理画面のログイン / ログアウト。
//
// ★ ふつうの HTML フォームから飛んでくる (fetch ではない)。パスワード
//   マネージャーは「フォームを送信して画面が変わった」ことを見て保存を提案する
//   ので、ここを fetch にすると Basic 認証のときと同じで覚えてもらえない。
//   だから応答は 303 リダイレクトで、JSON は返さない。
export const POST: APIRoute = async ({ request, locals }) => {
  const rt = (locals as any)?.runtime?.env;
  const user = rt?.ADMIN_USERNAME || import.meta.env.ADMIN_USERNAME || '';
  const passHash = rt?.ADMIN_PASSWORD_HASH || import.meta.env.ADMIN_PASSWORD_HASH || '';

  const form = await request.formData().catch(() => null);
  const secure = new URL(request.url).protocol === 'https:';

  // ログアウト … Cookie を空にして期限を切る
  if (form?.get('action') === 'logout') {
    return new Response(null, {
      status: 303,
      headers: { Location: '/admin/login?bye=1', 'Set-Cookie': cookieHeader('', 0, secure) },
    });
  }

  if (!user || !passHash) {
    return redirectBack(form, 'unconfigured');
  }

  const u = String(form?.get('username') ?? '');
  const p = String(form?.get('password') ?? '');
  if (!safeEqual(u, user) || !await passwordOk(p, passHash)) {
    // どちらが違うかは言わない (ユーザー名の総当たりの手掛かりになる)
    return redirectBack(form, 'ng');
  }

  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const value = await signSession(passHash, expiresAt);
  return new Response(null, {
    status: 303,
    headers: {
      Location: safeNext(String(form?.get('next') ?? '')),
      'Set-Cookie': cookieHeader(value, SESSION_DAYS * 24 * 60 * 60, secure),
    },
  });
};

function redirectBack(form: FormData | null, error: string): Response {
  const next = String(form?.get('next') ?? '');
  const q = new URLSearchParams({ error });
  if (next) q.set('next', safeNext(next));
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/admin/login?${q}`,
      // 入力し直しになるので、間違いのときは Cookie を触らない
      'Set-Cookie': `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    },
  });
}
