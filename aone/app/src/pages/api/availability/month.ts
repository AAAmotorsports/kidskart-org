import type { APIRoute } from 'astro';
import { envFrom, getSupabase, json } from '@lib/supabase';
import { todayJst } from '@lib/domain';

export const prerender = false;

// GET /api/availability/month?ym=2026-08
// 月カレンダー用のダイジェスト (日ごとの受付可否・ブロック・件数)。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = envFrom(locals);
  const ym = url.searchParams.get('ym') || todayJst().slice(0, 7);
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return json({ error: 'ym は YYYY-MM 形式で指定してください' }, 400);

  let data: unknown;
  try {
    const res = await getSupabase(env).rpc('aone_month_state', {
      p_year: Number(m[1]),
      p_month: Number(m[2]),
    });
    if (res.error) {
      console.warn('[availability/month] 失敗', res.error);
      return json({ error: '月間状況を取得できませんでした', detail: res.error.message }, 502);
    }
    data = res.data;
  } catch (e: any) {
    console.warn('[availability/month] Supabase に接続できません', e);
    return json({ error: '予約システムの設定が未完了です', detail: String(e?.message ?? e) }, 503);
  }

  return new Response(JSON.stringify({ ym, days: data }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
};
