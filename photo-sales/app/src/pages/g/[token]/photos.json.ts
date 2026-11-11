import type { APIRoute } from 'astro';
import { getPrices, getPublicGroup, listPhotoIds } from '@lib/public.ts';
import { getDb, json } from '@lib/env.ts';
export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  const db = getDb(locals);
  const g = await getPublicGroup(db, params.token!);
  if (!g || g.state === 'closed') return json({ state: 'closed' });
  if (g.state === 'preparing') return json({ state: 'preparing', title: g.name, date: g.shoot_date, time: g.start_time });
  return json({ state: 'open', title: g.name, date: g.shoot_date, time: g.start_time,
                prices: await getPrices(db), photos: await listPhotoIds(db, g.id) });
};
