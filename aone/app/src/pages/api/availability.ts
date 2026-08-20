import type { APIRoute } from 'astro';
import { envFrom, getSupabase, json } from '@lib/supabase';
import { todayJst } from '@lib/domain';

export const prerender = false;

// GET /api/availability?date=YYYY-MM-DD
// その日の受付状況をまるごと返す (「今日走れる？」/ 予約フォームの共通ソース)。
// 中身は DB 関数 aone_day_state() が計算する — ルールを TS 側に持たない。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = envFrom(locals);
  const date = url.searchParams.get('date') || todayJst();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date は YYYY-MM-DD 形式で指定してください' }, 400);
  }

  let data: unknown;
  try {
    const res = await getSupabase(env).rpc('aone_day_state', { p_date: date });
    if (res.error) {
      console.warn('[availability] aone_day_state 失敗', res.error);
      return json({ error: '空き状況を取得できませんでした', detail: res.error.message }, 502);
    }
    data = res.data;
  } catch (e: any) {
    // Supabase 未設定 (env が空) — セットアップ中はここに来る
    console.warn('[availability] Supabase に接続できません', e);
    return json({ error: '予約システムの設定が未完了です', detail: String(e?.message ?? e) }, 503);
  }

  return new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 予約が入った瞬間に反映されてほしいので短命キャッシュのみ
      'Cache-Control': 'public, max-age=30',
    },
  });
};
