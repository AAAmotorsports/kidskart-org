// 管理画面のログイン。
//
// もとは HTTP Basic 認証だった。ブラウザが出すダイアログは**パスワード
// マネージャーの保存対象にならない** (Chrome、とくに iOS は一切覚えない) ので、
// スタッフが毎回パスワードを打つことになっていた (2026-09 オーナー指摘)。
// ふつうの HTML ログインフォームに変え、合言葉は署名付き Cookie で持つ。
//
// * パスワードは今までどおり SHA-256 ダイジェスト (ADMIN_PASSWORD_HASH) だけを
//   置く。平文はリポジトリにも Worker にも置かない
// * Cookie の署名鍵はそのダイジェストから作る。**新しいシークレットを増やさない**
//   ためと、パスワードを変えたら古い Cookie が自動で無効になるため
// * スタッフごとのログインが必要になったら Supabase Auth に置き換える

export const ADMIN_COOKIE = 'aone_admin';

/** ログインを保つ日数。毎日使う道具なので長め (スマホで開きっぱなしにする) */
export const SESSION_DAYS = 30;

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(buf));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 長さが違っても早く抜けない比較 (総当たりの手掛かりを残さない) */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return hex(new Uint8Array(sig));
}

/**
 * Cookie の中身を作る。`<期限(ミリ秒)>.<署名>` だけ。
 * 誰がログインしたかは持たない (今はアカウントが 1 つしかない)。
 */
export async function signSession(passHash: string, expiresAt: number): Promise<string> {
  const body = String(expiresAt);
  return `${body}.${await hmacHex(passHash, body)}`;
}

/** Cookie が本物で、期限内かどうか */
export async function verifySession(value: string, passHash: string): Promise<boolean> {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, await hmacHex(passHash, body))) return false;
  const exp = Number(body);
  return Number.isFinite(exp) && exp > Date.now();
}

/** パスワードが合っているか (ハッシュ同士で比べる) */
export async function passwordOk(password: string, passHash: string): Promise<boolean> {
  return safeEqual(await sha256Hex(password), passHash.toLowerCase());
}

/** リクエストの Cookie から 1 つ取り出す */
export function readCookie(request: Request, name: string): string {
  const raw = request.headers.get('cookie') ?? '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/**
 * Set-Cookie の中身。
 * `secure` は https のときだけ付ける — 付けると開発機の http では保存されない。
 */
export function cookieHeader(value: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    // JavaScript から読めないようにする (XSS で持ち出されない)
    'HttpOnly',
    // 外部サイトからの POST には付かない。ふつうのリンクでは付く
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * ログイン後の行き先。**管理画面の中しか許さない。**
 * ここを緩めると `?next=https://…` で外部サイトへ飛ばせてしまう
 * (フィッシングの踏み台になる)。
 */
export function safeNext(next: string | null): string {
  if (!next) return '/admin';
  // `//example.com` や `/\example.com` はブラウザが外部として解釈する
  if (!next.startsWith('/admin') || next.startsWith('//') || next.includes('\\')) return '/admin';
  return next;
}
