import type { APIRoute } from 'astro';
import { envFrom } from '@lib/supabase';
import { POST as thankyouPOST } from '../cron/thankyou-mail';
import { POST as reminderPOST } from '../cron/reminder-mail';
import { POST as followupPOST } from '../cron/followup-mail';

export const prerender = false;

// POST /api/admin/cron-retry
//
// Admin 認証 (middleware の Basic Auth) 経由で cron を手動再実行するための
// エンドポイント。CRON_SECRET は Cloudflare の Secret で書き込み専用に
// なるため、admin 画面から curl 相当のことを直接やらせるのは現実的でない。
//
// 実装メモ:
//   最初は fetch(`${origin}/api/cron/...`) で自 Worker に HTTP 越しで
//   叩いていたが、Cloudflare Workers が自分自身に fetch すると Edge を
//   経由してループし 522 (connection timed out) になる。
//   → 同一 Worker 内なのでハンドラ関数を直接呼び出せば良い。
//   合成 Request に `x-cron-secret` を積んで渡す形にする。
//
// 用途:
//   - 遅延事故等で送信が漏れた予約の手動再送 (今回の 08/29 事故対応)
//   - 開催日直後の即時テスト送信 (?date=YYYY-MM-DD 指定)
//
// Body: { cron: 'thankyou-mail'|'reminder-mail'|'followup-mail', date?: 'YYYY-MM-DD' }
// Response: cron ハンドラの生レスポンスをそのまま返す。

const CRON_HANDLERS: Record<string, APIRoute> = {
  'thankyou-mail': thankyouPOST as APIRoute,
  'reminder-mail': reminderPOST as APIRoute,
  'followup-mail': followupPOST as APIRoute,
};

export const POST: APIRoute = async (ctx) => {
  const env = envFrom(ctx.locals);
  const secret = env.CRON_SECRET;
  if (!secret) return json({ error: 'CRON_SECRET not configured' }, 500);

  let body: any;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const cron = String(body?.cron ?? '').trim();
  const date = body?.date ? String(body.date).trim() : '';

  const handler = CRON_HANDLERS[cron];
  if (!handler) {
    return json({ error: `unknown cron: ${cron}` }, 400);
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  }

  // cron ハンドラ側は request.url から origin と ?date=... を、request の
  // ヘッダから x-cron-secret を読む。実 URL 由来の origin (メール本文の
  // 予約リンクに使う) を維持したいので、admin リクエストの origin を
  // そのまま流用する。
  const url = new URL(ctx.request.url);
  const target = new URL(`/api/cron/${cron}${date ? `?date=${encodeURIComponent(date)}` : ''}`, `${url.protocol}//${url.host}`);
  const syntheticRequest = new Request(target.toString(), {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });

  // ctx をそのまま渡すと request が admin のもののままなので、request
  // だけ差し替えた新しい ctx を渡す。locals (Worker env) は流用。
  const cronCtx = { ...ctx, request: syntheticRequest, url: target } as any;
  return await handler(cronCtx);
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
