import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// POST /api/reserve/lookup
//
// Given a guardian phone number, return the most recent matching
// guardian row + all linked children so the wizard can prefill.
// Also fetches each child's *last* height / photo_consent from
// reservation_participants (customers table doesn't carry those).
//
// This is a low-friction "returning customer" flow, no auth. Phone
// number is treated as a soft identifier — someone with a known phone
// could see the guardian's name / address / email. For a small kart
// school MVP this matches the same trust level as Reserva; a proper
// magic-link email flow can replace it later.
//
// Body: { phone: string }
// Response: { found: true, guardian, customers } | { found: false }

export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const raw = String(body?.phone ?? '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 10 || digits.length > 11) {
    return json({ error: '電話番号を正しく入力してください（10〜11桁）' }, 400);
  }

  // Try exact match first, then digit-normalized fallback (users type
  // 090-1234-5678 vs 09012345678 inconsistently).
  const { data: exact } = await supabase
    .from('guardians')
    .select('id, name, kana, phone, email, postal_code, address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation, created_at')
    .eq('phone', raw)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let guardian = exact;
  if (!guardian) {
    const { data: pool } = await supabase
      .from('guardians')
      .select('id, name, kana, phone, email, postal_code, address, emergency_contact_name, emergency_contact_phone, emergency_contact_relation, created_at')
      .order('created_at', { ascending: false })
      .limit(500);
    guardian = (pool ?? []).find((g: any) => g.phone.replace(/[^0-9]/g, '') === digits) ?? null;
  }

  if (!guardian) return json({ found: false });

  // Linked customers via guardian_customer_links
  const { data: links } = await supabase
    .from('guardian_customer_links')
    .select('customer_id, customers(id, name, kana, birth_date, gender)')
    .eq('guardian_id', guardian.id);

  const customers: any[] = [];
  for (const link of (links ?? []) as any[]) {
    const c = link.customers;
    if (!c) continue;

    // Fetch last-used height / photo_consent from the most recent
    // reservation_participants row for this customer.
    const { data: last } = await supabase
      .from('reservation_participants')
      .select('height_cm, photo_consent, kart_experience_note')
      .eq('customer_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    customers.push({
      id: c.id,
      name: c.name,
      kana: c.kana,
      birth_date: c.birth_date,
      gender: c.gender,
      height_cm: last?.height_cm ?? null,
      photo_consent: last?.photo_consent ?? 'allow',
      kart_experience_note: last?.kart_experience_note ?? null,
    });
  }

  return json({
    found: true,
    guardian: {
      name: guardian.name,
      kana: guardian.kana,
      phone: guardian.phone,
      email: guardian.email,
      postal_code: guardian.postal_code ?? '',
      address: guardian.address ?? '',
      emergency_contact_name: guardian.emergency_contact_name ?? '',
      emergency_contact_phone: guardian.emergency_contact_phone ?? '',
      emergency_contact_relation: guardian.emergency_contact_relation ?? '',
    },
    customers,
  });
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
