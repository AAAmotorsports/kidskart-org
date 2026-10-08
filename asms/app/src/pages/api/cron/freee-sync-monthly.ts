import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { logCronRun } from '@lib/cron-log';
import { syncMonthlyFreeeDeals } from '@lib/freee-monthly-sync';

export const prerender = false;

// POST /api/cron/freee-sync-monthly[?ym=YYYY-MM]
//
// 毎月 1 日 10:00 JST (= 01:00 UTC) に Cloudflare Workers Cron Trigger から
// 叩かれ、前月分の ASMS 売上を集計して freee に income deal を 2 件
// (現金 / PayPay) 登録する。
//
// 冪等性: ref_number (`KS-YYYY-MM-CASH` / `KS-YYYY-MM-PAYPAY`) で freee 側に
// 既存 deal があり金額一致なら新規作成せずスキップ。
//
// 認証: x-cron-secret ヘッダで env.CRON_SECRET と一致確認
// (既存の thankyou/reminder/followup と同じ流儀)。
//
// ym クエリパラメーター指定時はその月を対象にする (手動再実行用)。
// 省略時は JST での現在月から 1 ヶ月戻した月 = 前月。
//
// エラー時: Supabase の monthly_freee_sync.status を 'error' or 'partial' に
// 書き戻し、admin/sales 画面でバッジ表示される。

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);

  const provided = request.headers.get('x-cron-secret') ?? '';
  const expected = env.CRON_SECRET ?? '';
  if (!expected) return json({ error: 'CRON_SECRET not configured' }, 500);
  if (provided !== expected) return json({ error: 'unauthorized' }, 401);

  const supabase = getSupabaseAdmin(env);

  const urlObj = new URL(request.url);
  const ymParam = urlObj.searchParams.get('ym') || undefined;
  if (ymParam && !/^\d{4}-\d{2}$/.test(ymParam)) {
    return json({ error: 'ym must be YYYY-MM' }, 400);
  }

  try {
    const result = await logCronRun(supabase, 'freee-sync-monthly', async () => {
      return await syncMonthlyFreeeDeals(supabase, env as any, { ym: ymParam });
    });
    const httpStatus = result.status === 'error' ? 500 : 200;
    return json(result, httpStatus);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    console.error('[freee-sync-monthly] exception:', msg);
    return json({ error: msg }, 500);
  }
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
