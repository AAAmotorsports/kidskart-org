import type { APIRoute } from 'astro';
import { getTvState } from '@lib/public.ts';
import { getDb, json } from '@lib/env.ts';
export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const s = await getTvState(getDb(locals), params.token!);
  return s ? json(s) : json({ error: 'not_found' }, 404);
};
