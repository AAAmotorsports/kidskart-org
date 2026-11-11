import type { Db } from './shop/db.ts';
import { viewEnd } from './shop/time.ts';
import { todayJst } from './jst.ts';

export type PublicState = 'closed' | 'preparing' | 'open';
export interface PublicGroup { id: string; name: string | null; shoot_date: string; start_time: string | null; state: PublicState }

/**
 * お客様に見せてよいグループか。見せてよいのは 同意済み (online_ok) かつ 閲覧期間内 のものだけ。
 * 見せられない理由 (非公開・同意なし・期限切れ・存在しない) は区別せず 'closed' (理由を漏らさない)
 */
export async function getPublicGroup(db: Db, token: string, now = new Date()): Promise<PublicGroup | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const g = await db.prepare(
    `SELECT id, name, shoot_date, start_time, status, online_ok FROM groups WHERE qr_token = ?`)
    .bind(token).first<{ id: string; name: string | null; shoot_date: string; start_time: string | null; status: string; online_ok: number }>();
  if (!g) return null;
  const ret = await db.prepare(`SELECT json_extract(value,'$.view_days') AS d FROM settings WHERE key='retention'`).first<{ d: number }>();
  const expired = now >= viewEnd(g.shoot_date, ret?.d ?? 30);
  let state: PublicState = 'closed';
  if (g.online_ok && !expired) state = g.status === 'published' ? 'open' : g.status === 'preparing' ? 'preparing' : 'closed';
  return { id: g.id, name: g.name, shoot_date: g.shoot_date, start_time: g.start_time, state };
}

export async function listPhotoIds(db: Db, groupId: string, limit = 1000): Promise<string[]> {
  return (await db.prepare(
    `SELECT id FROM photos WHERE group_id = ? AND status = 'ready' ORDER BY taken_at, id LIMIT ?`)
    .bind(groupId, limit).all<{ id: string }>()).results.map((r) => r.id);
}

/** お客様用の画像 (プレビュー/サムネ) を返してよいときだけキーを返す */
export async function customerImageKey(db: Db, token: string, photoId: string, kind: string, now = new Date()): Promise<string | null> {
  if (kind !== 'thumb' && kind !== 'preview') return null;
  const g = await getPublicGroup(db, token, now);
  if (!g || g.state !== 'open') return null;
  const col = kind === 'thumb' ? 'thumb_key' : 'preview_key';
  const r = await db.prepare(`SELECT ${col} AS k FROM photos WHERE id = ? AND group_id = ? AND status = 'ready'`)
    .bind(photoId, g.id).first<{ k: string }>();
  return r?.k ?? null;
}

export async function getPrices(db: Db): Promise<{ single: number; set3: number; pack: number }> {
  const r = await db.prepare(`SELECT value FROM settings WHERE key = 'prices'`).first<{ value: string }>();
  return JSON.parse(r!.value);
}

// ---- テレビ ------------------------------------------------------------------
export interface TvGroup { id: string; name: string | null; time: string | null; priority: string | null; photos: string[] }
export interface TvState { mode: 'auto' | 'manual' | 'off'; slideSeconds: number; groupSeconds: number; groups: TvGroup[] }

/** TV に出してよいのは tv_ok (撮影・TV の同意あり、未成年は保護者同意あり) の団体の写真だけ */
export async function getTvState(db: Db, tvToken: string, now = new Date()): Promise<TvState | null> {
  if (!/^[0-9a-f]{32}$/.test(tvToken)) return null;
  const t = await db.prepare(`SELECT mode, group_id, slide_seconds, group_seconds FROM tv_state WHERE id = 1 AND tv_token = ?`)
    .bind(tvToken).first<{ mode: 'auto' | 'manual' | 'off'; group_id: string | null; slide_seconds: number; group_seconds: number }>();
  if (!t) return null;
  const base = { mode: t.mode, slideSeconds: t.slide_seconds, groupSeconds: t.group_seconds };
  if (t.mode === 'off') return { ...base, groups: [] };
  const rows = t.mode === 'manual'
    ? (t.group_id ? (await db.prepare(
        `SELECT id, name, start_time, tv_priority_at FROM groups WHERE id = ? AND tv_ok = 1 AND status IN ('preparing','published')`)
        .bind(t.group_id).all<any>()).results : [])
    : (await db.prepare(
        `SELECT id, name, start_time, tv_priority_at FROM groups
          WHERE tv_ok = 1 AND status IN ('preparing','published') AND shoot_date = ?
          ORDER BY tv_priority_at DESC, created_at DESC LIMIT 12`).bind(todayJst(now)).all<any>()).results;
  const groups: TvGroup[] = [];
  for (const r of rows) {
    const photos = (await db.prepare(
      `SELECT id FROM photos WHERE group_id = ? AND status = 'ready' ORDER BY taken_at, id LIMIT 200`)
      .bind(r.id).all<{ id: string }>()).results.map((x) => x.id);
    if (photos.length) groups.push({ id: r.id, name: r.name, time: r.start_time, priority: r.tv_priority_at, photos });
  }
  return { ...base, groups };
}

export async function tvImageKey(db: Db, tvToken: string, photoId: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(tvToken)) return null;
  const r = await db.prepare(
    `SELECT p.preview_key AS k FROM photos p JOIN groups g ON g.id = p.group_id, tv_state t
      WHERE p.id = ? AND p.status = 'ready' AND g.tv_ok = 1 AND g.status IN ('preparing','published')
        AND t.id = 1 AND t.tv_token = ? AND t.mode <> 'off'`)
    .bind(photoId, tvToken).first<{ k: string }>();
  return r?.k ?? null;
}
