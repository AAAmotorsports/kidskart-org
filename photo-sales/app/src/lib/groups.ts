import type { Db } from './shop/db.ts';

export interface GroupInput {
  shoot_date: string; start_time: string | null; name: string | null; headcount: number | null;
  plan: 'rental' | 'race_pack' | 'other';
  consent_shoot: boolean; consent_online: boolean; consent_tv: boolean;
  has_minor: boolean; guardian_consent: boolean; consent_note: string | null;
}

/** フォーム入力を検証して正規化 (エラー時は文字列を返す) */
export function parseGroupForm(f: FormData): GroupInput | string {
  const s = (k: string) => String(f.get(k) ?? '').trim();
  const b = (k: string) => f.get(k) === 'on' || f.get(k) === '1';
  const date = s('shoot_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '利用日が正しくありません';
  const time = s('start_time');
  if (time && !/^\d{2}:\d{2}$/.test(time)) return '走行開始時間が正しくありません';
  const hc = s('headcount');
  let headcount: number | null = null;
  if (hc) {
    headcount = Number(hc);
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 500) return '人数は 1〜500 で入力してください';
  }
  const plan = s('plan') || 'rental';
  if (!['rental', 'race_pack', 'other'].includes(plan)) return 'プランが正しくありません';
  const g: GroupInput = {
    shoot_date: date, start_time: time || null, name: s('name').slice(0, 80) || null, headcount,
    plan: plan as GroupInput['plan'],
    consent_shoot: b('consent_shoot'), consent_online: b('consent_online'), consent_tv: b('consent_tv'),
    has_minor: b('has_minor'), guardian_consent: b('guardian_consent'),
    consent_note: s('consent_note').slice(0, 300) || null,
  };
  return g;
}

export async function createGroup(db: Db, g: GroupInput, staffId: string, now = new Date()): Promise<string> {
  const id = crypto.randomUUID().replaceAll('-', '');
  const consented = g.consent_shoot || g.consent_online || g.consent_tv ? now.toISOString() : null;
  await db.batch([
    db.prepare(
      `INSERT INTO groups(id, shoot_date, start_time, name, headcount, plan,
         consent_shoot, consent_online, consent_tv, has_minor, guardian_consent, consent_note,
         consented_at, consented_by, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, g.shoot_date, g.start_time, g.name, g.headcount, g.plan,
            +g.consent_shoot, +g.consent_online, +g.consent_tv, +g.has_minor, +g.guardian_consent,
            g.consent_note, consented, staffId, staffId),
    db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id, detail) VALUES (?, 'group.create', 'group', ?, ?)`)
      .bind(staffId, id, JSON.stringify({ name: g.name })),
  ]);
  return id;
}

/**
 * 同意・基本情報の更新。同意が外れて公開できなくなったら、公開状態を自動で
 * 'hidden' に戻す (DB の CHECK が公開のままの更新を拒否するので、先に戻す)。
 */
export async function updateGroup(db: Db, id: string, g: GroupInput, staffId: string, now = new Date()): Promise<void> {
  const publishable = g.consent_shoot && g.consent_online && (!g.has_minor || g.guardian_consent);
  await db.batch([
    db.prepare(`UPDATE groups SET status = 'hidden' WHERE id = ? AND status = 'published' AND ? = 0`)
      .bind(id, +publishable),
    db.prepare(
      `UPDATE groups SET shoot_date=?, start_time=?, name=?, headcount=?, plan=?,
         consent_shoot=?, consent_online=?, consent_tv=?, has_minor=?, guardian_consent=?, consent_note=?,
         consented_at=?, consented_by=? WHERE id = ? AND status <> 'deleted'`)
      .bind(g.shoot_date, g.start_time, g.name, g.headcount, g.plan,
            +g.consent_shoot, +g.consent_online, +g.consent_tv, +g.has_minor, +g.guardian_consent,
            g.consent_note, now.toISOString(), staffId, id),
    db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id, detail) VALUES (?, 'group.update', 'group', ?, ?)`)
      .bind(staffId, id, JSON.stringify({ consent: [g.consent_shoot, g.consent_online, g.consent_tv, g.has_minor, g.guardian_consent] })),
  ]);
}

/** 公開 / 非公開。公開は同意が揃っているときだけ (DB の CHECK が最終防衛線) */
export async function setPublished(db: Db, id: string, publish: boolean, staffId: string, now = new Date()): Promise<boolean> {
  const r = publish
    ? await db.prepare(
        `UPDATE groups SET status = 'published', published_at = COALESCE(published_at, ?)
          WHERE id = ? AND status IN ('preparing','hidden') AND online_ok = 1`)
        .bind(now.toISOString(), id).run()
    : await db.prepare(`UPDATE groups SET status = 'hidden' WHERE id = ? AND status = 'published'`).bind(id).run();
  if (r.meta.changes) {
    await db.prepare(`INSERT INTO audit_logs(staff_id, action, target_type, target_id) VALUES (?, ?, 'group', ?)`)
      .bind(staffId, publish ? 'group.publish' : 'group.unpublish', id).run();
  }
  return r.meta.changes === 1;
}
