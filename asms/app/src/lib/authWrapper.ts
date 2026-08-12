// Thin abstraction over Supabase Auth so we can swap Magic Link out
// for Passkey (WebAuthn) later without touching the pages.
//
// Design notes (see asms/CLAUDE.md 認証・顧客識別ポリシー):
// - Uses Supabase Auth's auth.users table as-is; no custom auth tables.
// - Magic Link (OTP by email) is the only enabled method today.
// - Passkey will land as a swap-in for `signIn()`; the return shape
//   here already matches what WebAuthn will need.
// - Session is persisted in localStorage by supabase-js so refresh
//   keeps the user signed in until token expiry.

import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/**
 * Get (or lazily create) the browser-side Supabase client with
 * session persistence enabled. Only call from client-side JS.
 */
export function getAuthClient(url: string, anonKey: string): SupabaseClient {
  if (_client) return _client;
  _client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'asms:auth',
    },
  });
  return _client;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

/**
 * Send a Magic Link to the given email. The user clicks it and lands
 * at `redirectTo`, where detectSessionInUrl parses the hash tokens.
 *
 * NOTE: `redirectTo` MUST be in the Supabase project's allowed
 * redirect URLs list (Dashboard → Auth → URL Configuration).
 */
export async function sendMagicLink(
  client: SupabaseClient,
  email: string,
  redirectTo: string,
): Promise<AuthResult> {
  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
      shouldCreateUser: true,
    },
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Current session, if any. Also parses hash-fragment tokens on the
 * callback page (via detectSessionInUrl).
 */
export async function currentSession(client: SupabaseClient): Promise<Session | null> {
  const { data } = await client.auth.getSession();
  return data.session ?? null;
}

export async function signOut(client: SupabaseClient): Promise<void> {
  await client.auth.signOut();
}

/**
 * Placeholder for future Passkey support. Kept here so callers can
 * be ported by swapping this file only.
 */
export async function signInWithPasskey(_client: SupabaseClient): Promise<AuthResult> {
  return { ok: false, error: 'Passkey は未実装 (Future)' };
}
