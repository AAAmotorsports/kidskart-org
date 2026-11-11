import type { APIRoute } from 'astro';
import { getDb, redirect } from '@lib/env.ts';
import { randomHex } from '@lib/auth.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const db = getDb(locals);
  const f = await request.formData();
  const staff = locals.staff!;
  const now = new Date().toISOString();
  if (f.get('action') === 'regen') {
    await db.batch([
      db.prepare(`UPDATE tv_state SET tv_token = ?, updated_at = ? WHERE id = 1`).bind(randomHex(16), now),
      db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type) VALUES (?, 'tv.regen_token', 'tv')`).bind(staff.id),
    ]);
    return redirect('/admin/tv?saved=1');
  }
  const mode = String(f.get('mode'));
  const clamp = (k: string, lo: number, hi: number, d: number) => { const n = Math.round(Number(f.get(k))); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const gid = String(f.get('group_id') ?? '');
  await db.batch([
    db.prepare(`UPDATE tv_state SET mode = ?, group_id = ?, slide_seconds = ?, group_seconds = ?, updated_at = ? WHERE id = 1`)
      .bind(['auto', 'manual', 'off'].includes(mode) ? mode : 'auto', /^[0-9a-f]{32}$/.test(gid) ? gid : null,
            clamp('slide_seconds', 2, 60, 6), clamp('group_seconds', 10, 600, 60), now),
    db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, detail) VALUES (?, 'tv.update', 'tv', ?)`).bind(staff.id, JSON.stringify({ mode })),
  ]);
  return redirect('/admin/tv?saved=1');
};
