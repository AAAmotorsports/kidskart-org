import type { APIRoute } from 'astro';
import { envFrom, getSupabase, json } from '@lib/supabase';
import { todayJst } from '@lib/domain';

export const prerender = false;

// GET /api/rp/bookings?date=YYYY-MM-DD
//
// その日にすでに入っている RP 予約の「開始時間・人数・表示名」だけを返す。
// 旧スケジュールページ (WordPress) が「AM10:00〜 RP パットリ様」と出していた
// 運用に合わせて、予約画面で他のグループの入り具合が見えるようにするためのもの。
//
// 名前の出し方は /admin/settings の public_name_display で決まる
// (full: そのまま / family: 姓のみ / hidden: 名前を出さない)。
// 電話番号・メール・予約番号は返さない。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = envFrom(locals);
  const date = url.searchParams.get('date') || todayJst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date は YYYY-MM-DD 形式で指定してください' }, 400);
  }

  try {
    const { data, error } = await getSupabase(env).rpc('aone_rp_day_bookings', { p_date: date });
    if (error) {
      console.warn('[rp/bookings] 取得失敗', error);
      return json({ date, bookings: [] });
    }
    return new Response(JSON.stringify({ date, bookings: data ?? [] }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (e) {
    console.warn('[rp/bookings] Supabase に接続できません', e);
    return json({ date, bookings: [] });
  }
};
