import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

// GET /api/me/prefill
// Returns the authenticated caller's guardian + their most recent
// reservation participants, in a shape the reserve wizard can consume
// directly. Requires a valid Supabase Auth JWT in Authorization header.
//
// Response shape mirrors what localStorage prefill saves so the same
// wizard code path can populate the form.

export const GET: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return new Response(JSON.stringify({ error: 'no token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
  const authUserId = userData.user.id;

  const admin = getSupabaseAdmin(env);

  // Try to find guardian by auth_user_id first (the durable link).
  // Fall back to email match for the case where link.ts hasn't run yet
  // (concurrent callback race, or user cleared cookies).
  let { data: guardian } = await admin
    .from('guardians')
    .select('id, name, kana, phone, email, postal_code, address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation')
    .eq('auth_user_id', authUserId)
    .maybeSingle();

  if (!guardian && userData.user.email) {
    const { data: byEmail } = await admin
      .from('guardians')
      .select('id, name, kana, phone, email, postal_code, address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation')
      .eq('email', userData.user.email)
      .maybeSingle();
    guardian = byEmail;
  }

  if (!guardian) {
    return new Response(JSON.stringify({ ok: true, guardian: null, participants: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Most recent reservation for this guardian (non-cancelled) to pull
  // participant snapshots from. Wizard prefills participants[] shape.
  const { data: lastRes } = await admin
    .from('reservations')
    .select(`
      id, created_at,
      reservation_participants(
        name_snapshot, kana_snapshot, birth_date_snapshot,
        gender_snapshot, height_cm, photo_consent
      )
    `)
    .eq('guardian_id', guardian.id)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const participants = ((lastRes as any)?.reservation_participants ?? []).map((p: any) => ({
    name: p.name_snapshot,
    kana: p.kana_snapshot,
    birth_date: p.birth_date_snapshot,
    gender: p.gender_snapshot,
    height_cm: p.height_cm,
    photo_consent: p.photo_consent,
  }));

  // Emergency-same-as-guardian heuristic: if all three emergency
  // fields match the guardian's own, mark it so the wizard checks
  // the "同じ" box.
  const sameAsGuardian = !!(
    guardian.emergency_contact_name === guardian.name &&
    guardian.emergency_contact_phone === guardian.phone
  );

  return new Response(JSON.stringify({
    ok: true,
    guardian: {
      name: guardian.name,
      kana: guardian.kana,
      phone: guardian.phone,
      email: guardian.email,
      postal_code: guardian.postal_code,
      address: guardian.address,
    },
    sameAsGuardian,
    emergency: sameAsGuardian ? null : {
      name: guardian.emergency_contact_name,
      phone: guardian.emergency_contact_phone,
      relation: guardian.emergency_contact_relation,
    },
    participants,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
