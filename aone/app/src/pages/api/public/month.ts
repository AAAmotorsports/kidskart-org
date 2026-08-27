import type { APIRoute } from 'astro';
import { envFrom, json } from '@lib/supabase';
import { monthState, rentalBookings } from '@lib/queries';
import { todayJst, BUSINESS_LABELS, SURFACE_LABELS, BLOCK_KIND_LABELS, blockLabel } from '@lib/domain';

export const prerender = false;

// GET /api/public/month?ym=2026-08
//
// WordPress の月間スケジュール表示用。今まで手入力していた表を、この JSON から
// 生成する (仕様 19: 管理カレンダーに 1 回入れれば全部に反映される)。
// 氏名は含めない — 予約の有無と受付可否だけ。
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: CORS });

export const GET: APIRoute = async ({ url, locals, request }) => {
  const env = envFrom(locals);
  const today = todayJst();
  const ym = url.searchParams.get('ym') || today.slice(0, 7);
  const m = ym.match(/^(\d{4})-(\d{2})$/);
  if (!m) return json({ error: 'ym は YYYY-MM 形式で指定してください' }, 400);

  const days = await monthState(env, Number(m[1]), Number(m[2]));
  if (!days) {
    return new Response(JSON.stringify({ error: '月間状況を取得できませんでした' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  }

  // RP・貸切の予約 (時間・人数・表示名のみ)。名前の粒度は /admin/settings 次第で、
  // 「名前は出さない」を選べば name が null になる。
  const lastDay = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  const bookings = await rentalBookings(env, `${ym}-01`, `${ym}-${String(lastDay).padStart(2, '0')}`);

  const origin = new URL(request.url).origin;
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  return new Response(JSON.stringify({
    ym,
    year: Number(m[1]),
    month: Number(m[2]),
    today,
    days: days.map((d) => ({
      date: d.date,
      day: Number(d.date.slice(8, 10)),
      dow: d.dow,
      weekday: WD[d.dow],
      is_holiday: d.is_holiday,
      business: d.business,
      business_label: d.business === 'open' ? null : (BUSINESS_LABELS[d.business] ?? d.business),
      surface: d.surface,
      surface_label: d.surface ? (SURFACE_LABELS[d.surface] ?? d.surface) : null,
      am_open: d.sport_am === 'true',
      pm_open: d.sport_pm === 'true',
      rp_free: d.rp_free,
      // label は「イベント ８０分耐久レース」のように種別を頭に付けたもの。
      // カレンダーのセルでは 2 行に分けて出したいので、name も別に渡す。
      events: (d.blocks ?? [])
        .filter((b) => b.is_public)
        .map((b) => {
          const name = (b.public_label || b.title || '').trim();
          return {
            label: blockLabel(b.kind, name),
            name,
            kind: b.kind,
            kind_label: BLOCK_KIND_LABELS[b.kind] ?? b.kind,
          };
        }),
      counts: d.counts,
      bookings: bookings[d.date] ?? [],
    })),
    links: {
      site: `${origin}/`,
      reserve: `${origin}/reserve`,
      schedule: `${origin}/schedule`,
    },
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      ...CORS,
    },
  });
};
