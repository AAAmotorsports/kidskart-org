import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

// POST /api/me/link
// Called from /auth/callback after Magic Link succeeds. Verifies the
// caller's JWT, and if a guardian row exists with the same email but
// no auth_user_id yet, links them. Idempotent — safe to call every
// callback.

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return new Response(JSON.stringify({ error: 'no token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify JWT — the anon client with the user's token gets the user
  // from Supabase Auth. Fresh anon client (not the cached one) so we
  // don't accidentally leak state.
  const anon = createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userData.user) {
    return new Response(JSON.stringify({ error: 'invalid token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const { id: authUserId, email } = userData.user;
  if (!email) {
    return new Response(JSON.stringify({ error: 'no email on auth user' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const admin = getSupabaseAdmin(env);

  // Look for a guardian with matching email but no link, or a matching
  // link already. If a guardian exists with a DIFFERENT auth_user_id
  // (shouldn't happen normally), leave it alone — return existing.
  const { data: existing, error: qErr } = await admin
    .from('guardians')
    .select('id, auth_user_id')
    .eq('email', email)
    .limit(1)
    .maybeSingle();
  if (qErr) {
    return new Response(JSON.stringify({ error: qErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!existing) {
    // New user — no prior guardian. Not an error; wizard will
    // create the guardian on first successful reservation.
    return new Response(JSON.stringify({ ok: true, linked: false, reason: 'no_guardian_yet' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (existing.auth_user_id && existing.auth_user_id !== authUserId) {
    // Rare: email reassignment or duplicate. Don't overwrite.
    return new Response(JSON.stringify({ ok: true, linked: false, reason: 'already_linked_to_other' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (existing.auth_user_id === authUserId) {
    return new Response(JSON.stringify({ ok: true, linked: true, reason: 'already_linked' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { error: uErr } = await admin
    .from('guardians')
    .update({ auth_user_id: authUserId })
    .eq('id', existing.id);
  if (uErr) {
    return new Response(JSON.stringify({ error: uErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, linked: true, reason: 'newly_linked' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
