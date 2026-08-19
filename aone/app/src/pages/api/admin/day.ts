import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { str, mapRpcError, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/day
// 営業状態 (天候) の設定 (仕様 8)。「今日走れる？」にリアルタイムで反映される。
// 天気予報だけで自動中止にはしない — ここを A-ONE が押したときだけ変わる。
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

  const date = str(body?.date);
  const status = str(body?.weather_status);
  const allowed = ['normal', 'rain_caution', 'checking', 'surface_recovery', 'cancelled', 'other'];
  if (!date) return json({ error: '日付が必要です' }, 400);
  if (!status || !allowed.includes(status)) return json({ error: '営業状態が不正です' }, 400);

  const { error } = await getSupabaseAdmin(env).from('aone_business_days').upsert({
    date,
    weather_status: status,
    status_message: str(body?.status_message) ?? null,
    staff_note: str(body?.staff_note) ?? null,
    updated_at: new Date().toISOString(),
    updated_by: str(body?.actor) ?? 'admin',
  }, { onConflict: 'date' });

  if (error) return mapRpcError(error);
  return json({ ok: true });
};
