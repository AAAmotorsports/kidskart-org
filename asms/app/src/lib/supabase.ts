import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Public / anon Supabase client — uses the anon key.
 * Row Level Security policies decide what data this can read.
 * Safe to call from any Astro server context.
 */
export function getSupabase(env: Env): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Service-role Supabase client — BYPASSES RLS.
 * Only use inside server API endpoints where the input is validated
 * and you explicitly want to write regardless of policy.
 */
export function getSupabaseAdmin(env: Env): SupabaseClient {
  return createClient(env.PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Read the runtime env from Astro's Cloudflare adapter context.
 * In dev (`astro dev`) values come from .env.local via import.meta.env.
 * In production (Cloudflare Pages) they come from context.locals.runtime.env.
 */
export function envFrom(locals: App.Locals): Env {
  const rt = (locals as any)?.runtime?.env;
  if (rt && rt.PUBLIC_SUPABASE_URL) return rt as Env;

  return {
    PUBLIC_SUPABASE_URL: import.meta.env.PUBLIC_SUPABASE_URL ?? '',
    PUBLIC_SUPABASE_ANON_KEY: import.meta.env.PUBLIC_SUPABASE_ANON_KEY ?? '',
    SUPABASE_SERVICE_ROLE_KEY: import.meta.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  } as Env;
}
