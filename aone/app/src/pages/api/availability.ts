import type { APIRoute } from 'astro';
import { envFrom, getSupabase, json } from '@lib/supabase';
import { todayJst } from '@lib/domain';

export const prerender = false;

// GET /api/availability?date=YYYY-MM-DD
// その日の受付状況をまるごと返す (「今日走れる？」/ 予約フォームの共通ソース)。
// 中身は DB 関数 aone_day_state() が計算する — ルールを TS 側に持たない。
/**
 * aone_day_state() の結果から、公開してよい部分だけを取り出す。
 *
 * この API は誰でも叩ける。DB 関数は管理画面と共用なので、
 * スタッフメモ・非公開の予定・予定のメモがそのまま入っている。
 * 公開面に出すのは「営業状況・路面状況・受付状況・公開予定」だけ。
 */
function publicView(state: any): any {
  if (!state || typeof state !== 'object') return state;
  const { business, surface, blocks, ...rest } = state;
  return {
    ...rest,
    // 0021 を当てる前の関数は business / surface を返さない。
    // 先にアプリだけがデプロイされる瞬間に画面が落ちないよう既定値で埋める。
    business: {
      status: business?.status ?? 'open',
      source: business?.source ?? 'manual',
      message: business?.message ?? null,   // 公開メッセージ (staff_note は落とす)
    },
    surface: { status: surface?.status ?? null },
    blocks: (Array.isArray(blocks) ? blocks : [])
      .filter((b: any) => b?.is_public)
      .map((b: any) => ({
        kind: b.kind, scope: b.scope, is_public: true,
        public_label: b.public_label,
        start_time: b.start_time, end_time: b.end_time,
      })),
  };
}

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

  return new Response(JSON.stringify(publicView(data)), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 予約が入った瞬間に反映されてほしいので短命キャッシュのみ
      'Cache-Control': 'public, max-age=30',
    },
  });
};
