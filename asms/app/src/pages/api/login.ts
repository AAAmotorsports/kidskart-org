import type { APIRoute } from 'astro';
import {
  ADMIN_COOKIE, SESSION_DAYS, cookieHeader, failedLoginDelay,
  passwordOk, safeEqual, safeNext, signSession,
} from '@lib/adminAuth';

export const prerender = false;

// POST /api/login … 管理画面のログイン / ログアウト。
//
// ★ ふつうの HTML フォームから飛んでくる (fetch ではない)。パスワード
//   マネージャーは「フォームを送信して画面が変わった」ことを見て保存を提案する
//   ので、ここを fetch にすると Basic 認証のときと同じで覚えてもらえない。
//   だから応答は 303 リダイレクトで、JSON は返さない。
//
// ★ /api/admin/* ではなく /api/login に置くのが肝 — /api/admin/* に置くと
//   middleware の認証ガードに弾かれて、未ログインのユーザーがログインを
//   試みた時点で 401 になる。
//
// ★ ログアウトも POST — GET にすると `<img src="/api/login">` のような
//   外部からの画像タグで勝手にログアウトさせられる。
export const POST: APIRoute = async ({ request, locals }) => {
  const rt = (locals as any)?.runtime?.env;
  const user = rt?.ADMIN_USERNAME || import.meta.env.ADMIN_USERNAME || '';
  const passHash = rt?.ADMIN_PASSWORD_HASH || import.meta.env.ADMIN_PASSWORD_HASH || '';
  const cookieSecret = rt?.ADMIN_COOKIE_SECRET || import.meta.env.ADMIN_COOKIE_SECRET || '';

  const form = await request.formData().catch(() => null);
  const secure = new URL(request.url).protocol === 'https:';

  // ログアウト … Cookie を空にして期限を切る
  if (form?.get('action') === 'logout') {
    return new Response(null, {
      status: 303,
      headers: { Location: '/admin/login?bye=1', 'Set-Cookie': cookieHeader('', 0, secure) },
    });
  }

  if (!user || !passHash || !cookieSecret) {
    // 設定不足 (ADMIN_COOKIE_SECRET 未設定を含む)。詳細はログに出さない
    // (cookieSecret 未設定を外部から見えると偽造の助けになる)。
    console.error('[login] configuration missing', {
      user: !!user, passHash: !!passHash, cookieSecret: !!cookieSecret,
    });
    return redirectBack(form, 'unconfigured');
  }

  const u = String(form?.get('username') ?? '');
  const p = String(form?.get('password') ?? '');
  if (!safeEqual(u, user) || !await passwordOk(p, passHash)) {
    // どちらが違うかは言わない (ユーザー名の総当たりの手掛かりになる)
    // 失敗時は 1 秒待たせて brute force を抑制
    await failedLoginDelay();
    return redirectBack(form, 'ng');
  }

  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const value = await signSession(cookieSecret, expiresAt);
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
