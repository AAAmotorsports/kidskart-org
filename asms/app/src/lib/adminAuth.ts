// 管理画面のログイン。
//
// 2026-10-23 セキュリティ修正 (security-review C1 + C3):
//   旧実装は ADMIN_PASSWORD_HASH (= SHA-256 hex) を そのまま HMAC 鍵として
//   使って Cookie を署名していた。この値は wrangler.jsonc 経由で公開 GitHub
//   repo に commit されていたため、誰でも Cookie を偽造して /admin に入れる
//   致命的な欠陥があった。
//
// 修正後:
//   * Cookie 署名鍵は ADMIN_COOKIE_SECRET (Cloudflare Dashboard Secret) を使う
//     → ADMIN_PASSWORD_HASH とは独立、git には出ない
//   * パスワードハッシュは scrypt (salt + stretching) に移行
//     → "scrypt:<salt_hex>:<hash_hex>" を Dashboard Secret で管理
//     → 旧 SHA-256 hex もフォールバックで受け付けるが警告ログを出す
//   * 失敗ログインは 1 秒の遅延を入れて brute force を抑制
//
// 旧コメント (そのまま有効):
//   HTTP Basic 認証はパスワードマネージャーの保存対象にならないので、
//   普通の HTML フォーム + 署名付き Cookie に変更。
//   スタッフ 1 人運用で成り立っているので user は 1 つ。
//   必要になったら Supabase Auth に置き換える。

import { scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCb) as unknown as (
  password: string | Uint8Array,
  salt: string | Uint8Array,
  keylen: number,
) => Promise<Buffer>;

export const ADMIN_COOKIE = 'asms_admin';

/** ログインを保つ日数。毎日使う道具なので長め (スマホで開きっぱなしにする) */
export const SESSION_DAYS = 30;

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(buf));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(h: string): Uint8Array {
  const clean = h.toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
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
 * cookieSecret は env.ADMIN_COOKIE_SECRET (Dashboard Secret) から渡す。
 * 誰がログインしたかは持たない (今はアカウントが 1 つしかない)。
 */
export async function signSession(cookieSecret: string, expiresAt: number): Promise<string> {
  const body = String(expiresAt);
  return `${body}.${await hmacHex(cookieSecret, body)}`;
}

/** Cookie が本物で、期限内かどうか */
export async function verifySession(value: string, cookieSecret: string): Promise<boolean> {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, await hmacHex(cookieSecret, body))) return false;
  const exp = Number(body);
  return Number.isFinite(exp) && exp > Date.now();
}

/**
 * scrypt でパスワードをハッシュ化。保存形式: "scrypt:<salt_hex>:<hash_hex>"
 * N=16384, r=8, p=1, dkLen=32 (OWASP 推奨下限)。
 * Workers CPU time ~100ms なので login 時だけ呼ぶ。
 */
export async function hashPasswordScrypt(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const buf = await scryptAsync(password, salt, 32);
  return `scrypt:${hex(salt)}:${buf.toString('hex')}`;
}

/** パスワードが合っているか (hash 形式を自動判定) */
export async function passwordOk(password: string, passHash: string): Promise<boolean> {
  if (!passHash) return false;
  if (passHash.startsWith('scrypt:')) {
    const [, saltHex, expectedHex] = passHash.split(':');
    if (!saltHex || !expectedHex) return false;
    try {
      const actual = await scryptAsync(password, hexToBytes(saltHex), expectedHex.length / 2);
      return safeEqual(actual.toString('hex'), expectedHex.toLowerCase());
    } catch {
      return false;
    }
  }
  // Legacy SHA-256 (非推奨): 旧 wrangler.jsonc の値をそのまま受理。
  // CloudflareLogs に警告を出して運用担当者に scrypt 移行を促す。
  console.warn('[adminAuth] legacy SHA-256 password hash in use — rotate to scrypt (see CLAUDE.md).');
  return safeEqual(await sha256Hex(password), passHash.toLowerCase());
}

/**
 * 認証失敗時の時間稼ぎ。brute force を 1 req / sec に押さえる (scrypt の
 * 計算コストと合わせて実用上 1 req / 2 sec 程度になる)。
 * 成功時も僅かに走らせて成否で timing が割れないようにしたいが、
 * ユーザー体験優先で失敗時のみとする。
 */
export async function failedLoginDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1000));
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

/**
 * CSRF 防御 (security-review H3):
 * SameSite=Lax Cookie は外部サイトからの cross-site POST を基本防ぐが、
 * `kidskart.org` サブドメインを乗っ取られた場合や同一 origin 内の XSS
 * から守るため、admin POST エンドポイントは Origin / Referer ヘッダが
 * Worker 自身の host と一致することを追加検証する。
 *
 * `null` を返したら OK (リクエスト許可)、文字列を返したらエラーメッセージ
 * (呼び出し側で 403 を返す)。
 */
export function verifySameOrigin(request: Request): string | null {
  const url = new URL(request.url);
  const expectedHost = url.host;
  const originHdr = request.headers.get('origin');
  const refererHdr = request.headers.get('referer');

  // Origin がある場合は厳格に一致を要求 (ブラウザは cross-site POST では必ず付ける)
  if (originHdr) {
    try {
      const originHost = new URL(originHdr).host;
      if (originHost !== expectedHost) {
        return `Origin "${originHost}" does not match "${expectedHost}"`;
      }
      return null;
    } catch {
      return `Invalid Origin header`;
    }
  }
  // Origin が無い場合 (古いブラウザ / 一部の fetch) は Referer にフォールバック
  if (refererHdr) {
    try {
      const refererHost = new URL(refererHdr).host;
      if (refererHost !== expectedHost) {
        return `Referer "${refererHost}" does not match "${expectedHost}"`;
      }
      return null;
    } catch {
      return `Invalid Referer header`;
    }
  }
  // 両方欠落している (= 普通のブラウザからの POST ではない) → 蹴る。
  // 手元のスクリプト / curl は Origin を手動で付けること。
  return 'Missing Origin and Referer headers';
}
