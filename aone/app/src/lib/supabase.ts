import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * anon クライアント。RLS 配下で読める非機微データ専用。
 */
export function getSupabase(env: Env): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * service_role クライアント。RLS をバイパスする。
 * 入力を検証済みのサーバ側 API / 管理画面からのみ使う。
 */
export function getSupabaseAdmin(env: Env): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Cloudflare adapter の runtime env を読む。
 * dev (`astro dev`) では .env.local の import.meta.env にフォールバックする。
 */
export function envFrom(locals: App.Locals): Env {
  const rt = (locals as any)?.runtime?.env;
  if (rt && rt.PUBLIC_SUPABASE_URL) return rt as Env;

  return {
    PUBLIC_SUPABASE_URL: import.meta.env.PUBLIC_SUPABASE_URL ?? '',
    PUBLIC_SUPABASE_ANON_KEY: import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '',
    SUPABASE_SERVICE_ROLE_KEY: import.meta.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    RESEND_API_KEY: import.meta.env.RESEND_API_KEY,
    MAIL_FROM_ADDRESS: import.meta.env.MAIL_FROM_ADDRESS,
    MAIL_FROM_NAME: import.meta.env.MAIL_FROM_NAME,
    MAIL_REPLY_TO: import.meta.env.MAIL_REPLY_TO,
    MAIL_ADMIN_TO: import.meta.env.MAIL_ADMIN_TO,
    PUBLIC_SITE_NAME: import.meta.env.PUBLIC_SITE_NAME,
    PUBLIC_SITE_TEL: import.meta.env.PUBLIC_SITE_TEL,
    JMA_AREA_CODE: import.meta.env.JMA_AREA_CODE,
    JMA_AREA_NAME: import.meta.env.JMA_AREA_NAME,
    CRON_SECRET: import.meta.env.CRON_SECRET,
    ADMIN_USERNAME: import.meta.env.ADMIN_USERNAME,
    ADMIN_PASSWORD_HASH: import.meta.env.ADMIN_PASSWORD_HASH,
  } as Env;
}

/** JSON レスポンスの薄いヘルパ */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
