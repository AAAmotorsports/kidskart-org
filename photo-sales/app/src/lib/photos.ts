import type { Db } from './shop/db.ts';

export const LIMITS = { original: 20_000_000, preview: 1_500_000, thumb: 300_000 };

export interface UploadMeta {
  sha256: string; crc32: number; takenAt: string | null; width: number; height: number;
  sizes: [number, number, number];
}

/** アップロード時のメタ情報を厳密に検証する (不正なら文字列) */
export function parseUploadMeta(raw: string | null, bodyLen: number): UploadMeta | string {
  let m: any;
  try { m = JSON.parse(decodeURIComponent(raw ?? '')); } catch { return 'meta'; }
  if (!m || typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'sha256';
  if (!Number.isInteger(m.crc32) || m.crc32 < 0 || m.crc32 > 0xffffffff) return 'crc32';
  if (!Array.isArray(m.sizes) || m.sizes.length !== 3 || !m.sizes.every((n: any) => Number.isInteger(n) && n > 0)) return 'sizes';
  const [o, p, t] = m.sizes as number[];
  if (o > LIMITS.original || p > LIMITS.preview || t > LIMITS.thumb) return 'too_large';
  if (o + p + t !== bodyLen) return 'length_mismatch';
  const dim = (n: any) => Number.isInteger(n) && n > 0 && n < 20000;
  if (!dim(m.width) || !dim(m.height)) return 'dimensions';
  let takenAt: string | null = null;
  if (typeof m.takenAt === 'string') {
    const d = new Date(m.takenAt);
    if (!Number.isNaN(d.getTime())) takenAt = d.toISOString();
  }
  return { sha256: m.sha256, crc32: m.crc32, takenAt, width: m.width, height: m.height, sizes: [o, p, t] };
}

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** 写真 1 枚 (原本・プレビュー・サムネ) の保存。同じ内容 (sha256) が既にあれば 'duplicate' */
export async function storePhoto(
  env: { ORIGINALS: R2Bucket; PREVIEWS: R2Bucket }, db: Db,
  groupId: string, meta: UploadMeta, body: ArrayBuffer, now = new Date(),
): Promise<{ status: 'ok' | 'duplicate' | 'invalid'; id?: string }> {
  const dup = await db.prepare(`SELECT id FROM photos WHERE group_id = ? AND sha256 = ? AND status <> 'deleted'`)
    .bind(groupId, meta.sha256).first<{ id: string }>();
  if (dup) return { status: 'duplicate', id: dup.id };

  const [o, p, t] = meta.sizes;
  const orig = new Uint8Array(body, 0, o), prev = new Uint8Array(body, o, p), thumb = new Uint8Array(body, o + p, t);
  if (![orig, prev, thumb].every(isJpeg)) return { status: 'invalid' };

  const id = crypto.randomUUID().replaceAll('-', '');
  const keys = { original: `ph/${id}/original.jpg`, preview: `ph/${id}/preview.jpg`, thumb: `ph/${id}/thumb.jpg` };
  const ct = { httpMetadata: { contentType: 'image/jpeg' } };
  await Promise.all([
    env.ORIGINALS.put(keys.original, orig, ct),
    env.PREVIEWS.put(keys.preview, prev, ct),
    env.PREVIEWS.put(keys.thumb, thumb, ct),
  ]);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO photos(id, group_id, taken_at, sha256, crc32, original_key, preview_key, thumb_key, width, height, bytes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id, groupId, meta.takenAt ?? now.toISOString(), meta.sha256, meta.crc32,
              keys.original, keys.preview, keys.thumb, meta.width, meta.height, o),
      db.prepare(`UPDATE groups SET tv_priority_at = ? WHERE id = ?`).bind(now.toISOString(), groupId),
    ]);
  } catch {
    // 同時送信で sha256 が衝突した、など。置いたファイルを片付ける
    await Promise.all([env.ORIGINALS.delete(keys.original), env.PREVIEWS.delete([keys.preview, keys.thumb])]);
    const again = await db.prepare(`SELECT id FROM photos WHERE group_id = ? AND sha256 = ? AND status <> 'deleted'`)
      .bind(groupId, meta.sha256).first<{ id: string }>();
    return again ? { status: 'duplicate', id: again.id } : { status: 'invalid' };
  }
  return { status: 'ok', id };
}

/** 写真の削除 (R2 のファイルも即削除)。購入履歴のある写真は削除しない */
export async function deletePhotos(
  env: { ORIGINALS: R2Bucket; PREVIEWS: R2Bucket }, db: Db, ids: string[], staffId: string, now = new Date(),
): Promise<{ deleted: number; blocked: number }> {
  const j = JSON.stringify(ids);
  const rows = (await db.prepare(
    `SELECT p.id, p.original_key, p.preview_key, p.thumb_key,
            EXISTS(SELECT 1 FROM order_items i WHERE i.photo_id = p.id) AS sold
       FROM photos p WHERE p.id IN (SELECT value FROM json_each(?)) AND p.status <> 'deleted'`)
    .bind(j).all<{ id: string; original_key: string; preview_key: string; thumb_key: string; sold: number }>()).results;
  const ok = rows.filter((r) => !r.sold);
  if (ok.length) {
    await env.ORIGINALS.delete(ok.map((r) => r.original_key));
    await env.PREVIEWS.delete(ok.flatMap((r) => [r.preview_key, r.thumb_key]));
    await db.batch([
      db.prepare(`UPDATE photos SET status = 'deleted', deleted_at = ? WHERE id IN (SELECT value FROM json_each(?))`)
        .bind(now.toISOString(), JSON.stringify(ok.map((r) => r.id))),
      db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, detail) VALUES (?, 'photo.delete', 'photo', ?)`)
        .bind(staffId, JSON.stringify({ ids: ok.map((r) => r.id) })),
    ]);
  }
  return { deleted: ok.length, blocked: rows.length - ok.length };
}
