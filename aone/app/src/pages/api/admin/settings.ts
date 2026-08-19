import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { mapRpcError, str, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/settings
// 通常ルールの数値 (クラス上限・RP の刻み・キャンセル規定など) を変更する。
// 現場でルールが動いてもコードを触らずに済ませるための逃げ道 (仕様 20)。
const NUMERIC_FIELDS = [
  'max_classes_weekday_am', 'max_classes_weekday_pm',
  'max_classes_holiday_am', 'max_classes_holiday_pm',
  'rp_min_party', 'rp_slot_minutes', 'rp_duration_minutes',
  'rp_max_groups_per_start', 'rp_groups_block_sport', 'rp_cancel_deadline_hours',
];
const TIME_FIELDS = [
  'course_open_time', 'am_start_time', 'am_end_time',
  'pm_start_time', 'pm_end_time', 'course_close_time',
  'rp_first_start_time', 'rp_last_start_time', 'rp_late_limit_time',
  'charter_first_start_time', 'charter_last_end_time',
];

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: str(body?.actor) ?? 'admin',
  };

  for (const f of NUMERIC_FIELDS) {
    if (body?.[f] !== undefined && body[f] !== '') {
      const n = Number(body[f]);
      if (!Number.isFinite(n) || n < 0) return json({ error: `${f} の値が不正です` }, 400);
      patch[f] = n;
    }
  }
  for (const f of TIME_FIELDS) {
    const v = str(body?.[f]);
    if (v) {
      if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(v)) return json({ error: `${f} の形式が不正です` }, 400);
      patch[f] = v;
    }
  }

  const { error } = await getSupabaseAdmin(env).from('aone_settings').update(patch).eq('id', 1);
  if (error) return mapRpcError(error);
  return json({ ok: true });
};
