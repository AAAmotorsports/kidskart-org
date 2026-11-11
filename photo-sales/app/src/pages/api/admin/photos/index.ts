import type { APIRoute } from 'astro';
import { deletePhotos } from '@lib/photos.ts';
import { getDb, getEnv, json } from '@lib/env.ts';
export const prerender = false;

// 写真の一括操作: delete / hide / show / move
export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(locals);
  const staff = locals.staff!;
  const b = await request.json().catch(() => null) as any;
  const ids: string[] = Array.isArray(b?.ids) ? b.ids.filter((x: any) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x)).slice(0, 500) : [];
  if (!ids.length) return json({ error: 'no_ids' }, 400);
  const j = JSON.stringify(ids);

  if (b.action === 'delete') return json(await deletePhotos(getEnv(locals), db, ids, staff.id));

  if (b.action === 'hide' || b.action === 'show') {
    const [from, to] = b.action === 'hide' ? ['ready', 'hidden'] : ['hidden', 'ready'];
    const r = await db.prepare(`UPDATE photos SET status = ? WHERE status = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(to, from, j).run();
    return json({ changed: r.meta.changes });
  }

  if (b.action === 'move') {
    const to = String(b.toGroupId ?? '');
    const g = await db.prepare(`SELECT id FROM groups WHERE id = ? AND status <> 'deleted'`).bind(to).first();
    if (!g) return json({ error: 'group_not_found' }, 404);
    const sold = await db.prepare(`SELECT 1 AS x FROM order_items WHERE photo_id IN (SELECT value FROM json_each(?)) LIMIT 1`).bind(j).first();
    if (sold) return json({ error: 'sold' }, 409);        // 購入履歴のある写真は移動できない
    try {
      const r = await db.batch([
        db.prepare(`UPDATE photos SET group_id = ? WHERE status IN ('ready','hidden') AND id IN (SELECT value FROM json_each(?))`).bind(to, j),
        db.prepare(`UPDATE groups SET tv_priority_at = ? WHERE id = ?`).bind(new Date().toISOString(), to),
        db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id, detail) VALUES (?, 'photo.move', 'group', ?, ?)`)
          .bind(staff.id, to, JSON.stringify({ ids })),
      ]);
      return json({ moved: r[0].meta.changes });
    } catch {
      return json({ error: 'duplicate_in_target' }, 409);  // 移動先に同じ写真 (sha256) がある
    }
  }
  return json({ error: 'bad_action' }, 400);
};
