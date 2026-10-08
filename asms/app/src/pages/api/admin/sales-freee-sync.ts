import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { syncMonthlyFreeeDeals } from '@lib/freee-monthly-sync';

export const prerender = false;

// POST /api/admin/sales-freee-sync
// Body (JSON): { ym: 'YYYY-MM' }
//
// 管理画面 (/admin/sales) の「今すぐ freee に送信」ボタンから叩かれる。
// 中身は /api/cron/freee-sync-monthly と同じロジックを呼ぶが、
// 認証経路が違う:
//   - cron:  x-cron-secret ヘッダ (Cloudflare Workers Cron から)
//   - admin: Cookie (middleware で検証済み)
// なので cron-retry.ts と違いこちらは関数直接呼び出しで良い (synthetic Request
// を組み立てて x-cron-secret を再発行する必要が無い)。

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const ym: string | undefined = body?.ym;
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
    return json({ error: 'ym (YYYY-MM) is required' }, 400);
  }

  try {
    const result = await syncMonthlyFreeeDeals(supabase, env as any, { ym });
    return json(result, result.status === 'error' ? 500 : 200);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error('[admin sales-freee-sync] exception:', msg);
    return json({ error: msg }, 500);
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
