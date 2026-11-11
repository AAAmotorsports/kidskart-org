import type { APIRoute } from 'astro';
import { getDb, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const me = locals.staff!;
  if (me.role !== 'admin') return new Response('forbidden', { status: 403 });
  const db = getDb(locals);
  const f = await request.formData();
  const action = String(f.get('action'));
  const err = (m: string) => redirect(`/admin/staff?err=${encodeURIComponent(m)}`);
  if (action === 'add') {
    const email = String(f.get('email') ?? '').trim().toLowerCase();
    const name = String(f.get('name') ?? '').trim().slice(0, 40);
    const role = f.get('role') === 'admin' ? 'admin' : 'staff';
    if (!email.includes('@') || !name) return err('名前とメールアドレスを入力してください');
    try {
      await db.batch([
        db.prepare('INSERT INTO staff_users(email, name, role) VALUES (?, ?, ?)').bind(email, name, role),
        db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, detail) VALUES (?, 'staff.add', 'staff', ?)`).bind(me.id, JSON.stringify({ email, role })),
      ]);
    } catch { return err('そのメールアドレスは登録済みです'); }
  } else if (action === 'disable' || action === 'enable') {
    const id = String(f.get('id') ?? '');
    if (id === me.id) return err('自分自身は変更できません');
    await db.batch([
      db.prepare('UPDATE staff_users SET active = ? WHERE id = ?').bind(action === 'enable' ? 1 : 0, id),
      // 無効にしたらログイン中のセッションも即時に切る
      db.prepare('DELETE FROM sessions WHERE staff_id = ? AND ? = 0').bind(id, action === 'enable' ? 1 : 0),
      db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id) VALUES (?, ?, 'staff', ?)`).bind(me.id, `staff.${action}`, id),
    ]);
  }
  return redirect('/admin/staff');
};
