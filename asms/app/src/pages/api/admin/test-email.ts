import type { APIRoute } from 'astro';
import { envFrom } from '@lib/supabase';

export const prerender = false;

// GET /api/test/email?to=you@example.com
//
// Synchronous diagnostic endpoint: awaits the Resend fetch and returns
// the actual response (or thrown error) as JSON. Bypasses the wizard
// entirely so we can rule out payload / DB code paths. Admin-gated
// via the same Basic Auth middleware.
//
// DELETE THIS FILE after email delivery is confirmed working.

export const GET: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const url = new URL(request.url);
  const to = url.searchParams.get('to');

  const envKeys = Object.keys(env).sort();

  if (!to) {
    return json({
      error: 'Pass ?to=you@example.com',
      env_keys: envKeys,
    }, 400);
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return json({
      error: 'RESEND_API_KEY not set in runtime env',
      env_keys: envKeys,
    }, 500);
  }

  const from = env.MAIL_FROM_ADDRESS || 'noreply@kidskart.org';
  const fromName = env.MAIL_FROM_NAME || '福岡キッズカートアカデミー';

  const payload = {
    from: `${fromName} <${from}>`,
    to: [to],
    subject: `[TEST] ASMS メール送信確認 — ${new Date().toISOString().slice(11, 19)}`,
    text: 'これは ASMS の Resend 送信診断メールです。届いていれば設定は正常です。',
    html: '<p>これは <strong>ASMS</strong> の Resend 送信診断メールです。届いていれば設定は正常です。</p>',
  };

  let resendStatus = 0;
  let resendBody: any = null;
  let fetchError: string | null = null;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    resendStatus = r.status;
    const t = await r.text();
    try { resendBody = JSON.parse(t); } catch { resendBody = t; }
  } catch (e: any) {
    fetchError = e?.message || String(e);
  }

  return json({
    ok: resendStatus >= 200 && resendStatus < 300,
    env: {
      keys_seen: envKeys,
      has_api_key: !!apiKey,
      api_key_last4: apiKey.slice(-4),
      from: `${fromName} <${from}>`,
      to,
    },
    resend: {
      http_status: resendStatus,
      body: resendBody,
      fetch_error: fetchError,
    },
    hint: fetchError
      ? 'fetch itself failed — network or CF egress issue'
      : resendStatus === 200
        ? 'Success — email should arrive within 30s. Check Resend Dashboard → Emails.'
        : resendStatus === 401 || resendStatus === 403
          ? 'API key rejected — check RESEND_API_KEY value (may have been revoked)'
          : resendStatus === 422
            ? 'Payload rejected — likely from address not verified in Resend for this domain'
            : resendStatus === 0
              ? 'No response — RESEND_API_KEY likely missing or fetch cancelled'
              : `Unexpected ${resendStatus}`,
  });
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
