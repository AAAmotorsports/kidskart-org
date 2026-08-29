import type { APIRoute } from 'astro';
import { envFrom } from '@lib/supabase';

export const prerender = false;

// POST /api/admin/cron-retry
//
// Admin 認証 (middleware の Basic Auth) 経由で cron を手動再実行するための
// エンドポイント。CRON_SECRET は Cloudflare の Secret で書き込み専用に
// なるため、admin 画面から curl 相当のことを直接やらせるのは現実的でない。
// このエンドポイントは環境変数から CRON_SECRET を読んで内部的に
// /api/cron/<name> を呼び出す。
//
// 用途:
//   - 遅延事故等で送信が漏れた予約の手動再送 (今回の 08/29 事故対応)
//   - 開催日直後の即時テスト送信 (?date=YYYY-MM-DD 指定)
//
// Body: { cron: 'thankyou-mail'|'reminder-mail'|'followup-mail', date?: 'YYYY-MM-DD' }
// Response: cron エンドポイントの生レスポンスをそのまま返す。

const ALLOWED_CRONS = new Set(['thankyou-mail', 'reminder-mail', 'followup-mail']);

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const secret = env.CRON_SECRET;
  if (!secret) return json({ error: 'CRON_SECRET not configured' }, 500);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const cron = String(body?.cron ?? '').trim();
  const date = body?.date ? String(body.date).trim() : '';

  if (!ALLOWED_CRONS.has(cron)) {
    return json({ error: `unknown cron: ${cron}` }, 400);
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  }

  const url = new URL(request.url);
  const origin = env.PUBLIC_APP_URL || `${url.protocol}//${url.host}`;
  const target = `${origin}/api/cron/${cron}${date ? `?date=${encodeURIComponent(date)}` : ''}`;

  const r = await fetch(target, {
    method: 'POST',
    headers: { 'x-cron-secret': secret },
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
