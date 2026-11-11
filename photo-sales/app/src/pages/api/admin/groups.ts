import type { APIRoute } from 'astro';
import { createGroup, parseGroupForm } from '@lib/groups.ts';
import { getDb, redirect } from '@lib/env.ts';
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const g = parseGroupForm(await request.formData());
  if (typeof g === 'string') return redirect(`/admin/groups/new?err=${encodeURIComponent(g)}`);
  const id = await createGroup(getDb(locals), g, locals.staff!.id);
  return redirect(`/admin/groups/${id}`);
};
