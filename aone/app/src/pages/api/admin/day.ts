import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { str, mapRpcError, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/day
//
// 営業状況と路面状況の設定 (仕様 8)。「今日走れる？」にリアルタイムで反映される。
//
//   営業状況 (business_status) … 営業中 / 営業確認中 / 走行中止 / 休業
//                                 走行中止・休業は予約を止める
//   路面状況 (surface_status)  … ドライ / ウェット / ウェット→ドライ / ヘビーウェット
//                                 表示だけ。受付可否には影響しない。null = 未設定
//
// 天気予報だけで自動中止にはしない — ここを A-ONE が押したときだけ変わる。
//
// ★ ここを変えてもお客様には自動でメールを送らない。
//   急な休みは電話で連絡する運用のため。お知らせが要るときは
//   /api/admin/broadcast (一括連絡・個別連絡) から人が送る。
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
  if (!date) return json({ error: '日付が必要です' }, 400);

  const business = str(body?.business_status);
  const BUSINESS = ['open', 'checking', 'cancelled', 'closed'];
  if (!business || !BUSINESS.includes(business)) {
    return json({ error: '営業状況が不正です' }, 400);
  }

  // 路面は「未設定」を許す (空文字で消す)
  const SURFACE = ['dry', 'wet', 'drying', 'heavy_wet'];
  if ('surface_status' in (body ?? {})) {
    const surface = str(body.surface_status);
    if (surface && !SURFACE.includes(surface)) {
      return json({ error: '路面状況が不正です' }, 400);
    }
  }

  // 送られてこなかった項目は触らない。
  // 管理トップのワンタップ (営業状況だけを送る) が、日別画面で入れた
  // 路面状況やスタッフメモを消してしまわないようにするため。
  const patch: Record<string, unknown> = {
    date,
    business_status: business,
    updated_at: new Date().toISOString(),
    updated_by: str(body?.actor) ?? 'admin',
  };
  if ('surface_status' in (body ?? {})) patch.surface_status = str(body.surface_status) ?? null;
  if ('status_message' in (body ?? {})) patch.status_message = str(body.status_message) ?? null;
  if ('staff_note' in (body ?? {})) patch.staff_note = str(body.staff_note) ?? null;

  const { error } = await getSupabaseAdmin(env)
    .from('aone_business_days')
    .upsert(patch, { onConflict: 'date' });

  if (error) return mapRpcError(error);
  return json({ ok: true });
};
