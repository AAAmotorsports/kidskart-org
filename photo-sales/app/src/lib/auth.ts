// スタッフのログイン: メールで届くリンク (パスワード無し) + セッション Cookie。
//  * トークンは DB に SHA-256 だけ保存 (DB が漏れてもリンクは作れない)
//  * リンクは 15 分・1 回限り。メールのリンク先読み (スキャナ) で消費されないよう、
//    GET は確認画面だけ、ログインは POST (ボタン 1 回タップ)
//  * セッションは 30 日 (iPhone で毎回ログインしなくて済むように)
//  * 無料枠の CPU 10ms に収まる処理だけ (SHA-256 / 乱数のみ)
import type { Db } from './shop/db.ts';

export const COOKIE = 'photo_session';
export const SESSION_DAYS = 30;
export const LOGIN_LINK_MINUTES = 15;
const MAX_LINKS_PER_HOUR = 5;

export interface Staff { id: string; email: string; name: string; role: 'admin' | 'staff' }

export function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function parseCookies(h: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(value: string, maxAgeSec: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/**
 * ログインリンクを発行する。登録済みの有効なスタッフだけが対象。
 * 登録の有無を外から推測できないよう、呼び出し側は結果にかかわらず同じ画面を返すこと。
 * 戻り値: 発行したトークン (メール送信用) / 発行しなかった場合は null
 */
export async function issueLoginToken(db: Db, email: string, now = new Date()): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return null;
  const staff = await db.prepare('SELECT id FROM staff_users WHERE email = ? AND active = 1')
    .bind(e).first<{ id: string }>();
  if (!staff) return null;
  // 直近 1 時間に発行した数 (発行時刻 = 期限 - LOGIN_LINK_MINUTES)
  const issuedAfter = new Date(now.getTime() - 3600_000 + LOGIN_LINK_MINUTES * 60_000).toISOString();
  const recent = await db.prepare(
    `SELECT count(*) AS n FROM login_tokens WHERE staff_id = ? AND expires_at > ?`)
    .bind(staff.id, issuedAfter).first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_LINKS_PER_HOUR) return null;
  const token = randomHex(32);
  await db.prepare('INSERT INTO login_tokens(token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), staff.id,
          new Date(now.getTime() + LOGIN_LINK_MINUTES * 60_000).toISOString()).run();
  return token;
}

/** リンクのトークンを消費して、成功したら staff_id を返す (1 回限り) */
export async function consumeLoginToken(db: Db, token: string, now = new Date()): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await sha256Hex(token);
  const r = await db.prepare(
    `UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(now.toISOString(), h, now.toISOString()).run();
  if (r.meta.changes !== 1) return null;
  const row = await db.prepare(
    `SELECT t.staff_id AS id FROM login_tokens t JOIN staff_users s ON s.id = t.staff_id
      WHERE t.token_hash = ? AND s.active = 1`).bind(h).first<{ id: string }>();
  return row?.id ?? null;
}

export async function createSession(db: Db, staffId: string, now = new Date()): Promise<string> {
  const value = randomHex(32);
  await db.prepare('INSERT INTO sessions(id_hash, staff_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256Hex(value), staffId,
          new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString()).run();
  return value;
}

export async function staffFromCookie(db: Db, cookieHeader: string | null, now = new Date()): Promise<Staff | null> {
  const v = parseCookies(cookieHeader)[COOKIE];
  if (!v || !/^[0-9a-f]{64}$/.test(v)) return null;
  return db.prepare(
    `SELECT s.id, s.email, s.name, s.role FROM sessions x JOIN staff_users s ON s.id = x.staff_id
      WHERE x.id_hash = ? AND x.expires_at > ? AND s.active = 1`)
    .bind(await sha256Hex(v), now.toISOString()).first<Staff>();
}

export async function destroySession(db: Db, cookieHeader: string | null): Promise<void> {
  const v = parseCookies(cookieHeader)[COOKIE];
  if (v) await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256Hex(v)).run();
}

/** 期限切れのトークン・セッションを掃除 (cron) */
export async function purgeExpiredAuth(db: Db, now = new Date()): Promise<void> {
  const t = now.toISOString();
  await db.batch([
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(t),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
  ]);
}
