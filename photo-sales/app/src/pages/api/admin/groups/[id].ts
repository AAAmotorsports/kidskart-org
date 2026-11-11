import type { APIRoute } from 'astro';
import { parseGroupForm, setPublished, updateGroup } from '@lib/groups.ts';
import { getDb, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals, params }) => {
  const id = params.id!;
  const db = getDb(locals);
  const staff = locals.staff!;
  const f = await request.formData();
  const action = String(f.get('action') ?? 'update');
  const back = (q = '') => redirect(`/admin/groups/${id}${q}`);

  if (action === 'publish' || action === 'unpublish') {
    const ok = await setPublished(db, id, action === 'publish', staff.id);
    return back(ok ? '' : '?err=' + encodeURIComponent('公開できません (同意が揃っていません)'));
  }
  if (action === 'delete') {
    if (staff.role !== 'admin') return back('?err=' + encodeURIComponent('削除は管理者のみです'));
    // 写真ファイルは保存期間の cron が削除する (status='deleted' のグループの写真は即削除対象)
    await db.batch([
      db.prepare(`UPDATE groups SET status = 'deleted' WHERE id = ?`).bind(id),
      db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id) VALUES (?, 'group.delete', 'group', ?)`).bind(staff.id, id),
    ]);
    return redirect('/admin');
  }
  const g = parseGroupForm(f);
  if (typeof g === 'string') return back('?err=' + encodeURIComponent(g));
  await updateGroup(db, id, g, staff.id);
  return back('?saved=1');
};
