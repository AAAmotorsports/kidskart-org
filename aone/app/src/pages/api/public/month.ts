import type { APIRoute } from 'astro';
import { envFrom, json } from '@lib/supabase';
import { monthState, rentalBookings, openEvents } from '@lib/queries';
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
  // 参加申込を受け付けているイベントは、カレンダーから申込フォームへ飛ばす
  const open = await openEvents(env);
  const entryByDate = new Map(open.map((e) => [e.date, e.id]));

  const origin = new URL(request.url).origin;
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  // ウィジェットが使う 4 つだけに絞る。message や reason は運営向けの文言なので出さない
  const slimCats = (cats: any[] | undefined) => (cats ?? []).map((c) => ({
    code: c.code,
    short_name: c.short_name,
    status: c.status,
    running: c.running,
    requires_reservation: c.requires_reservation,
    // 止まっている理由 (weekly_closed / block / full など)。
    // 表示は理由で書き分けず一律「スポーツ走行 不可」にしているが、
    // 貼り付け先が自前で描くときのために渡しておく
    reason: c.reason,
  }));

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
      // ★ カテゴリーを渡さないと、ウィジェットは「予約が入っているクラス」
      //   (ミニバイク等) を出せず ○ のままになる。/schedule と食い違う
      //   (2026-09 オーナー指摘)。公開スケジュールに出しているものと同じ内容
      am_categories: slimCats(d.am_categories),
      pm_categories: slimCats(d.pm_categories),
      rp_free: d.rp_free,
      // ご予約不要のレンタルカート走行ができるか。
      // 営業していて、その時間帯の RP 枠が生きていれば走れる
      // (終日のレース・臨時休業・走行中止のときは枠が全部止まる)。
      // 「受付停止」を見たレンタルのお客様が来られないと思ってしまうのを防ぐ。
      // ★ 午前だけレースで埋まっている日があるので、午前 / 午後で分けて返す
      rental_ok: d.business === 'open' && d.rp_free > 0,
      rental_am: d.business === 'open' && (d.rp_free_am ?? 0) > 0,
      rental_pm: d.business === 'open' && (d.rp_free_pm ?? 0) > 0,
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
            // 予定名の横に AM / PM を出すのに使う
            scope: b.scope ?? null,
          };
        }),
      counts: d.counts,
      bookings: bookings[d.date] ?? [],
      // 申込受付中なら、そのイベントの案内ページ (資料 + 申込ボタン)。
      // 申込フォームに直行させると資料にたどり着けない
      entry_url: entryByDate.has(d.date)
        ? `${origin}/event/${entryByDate.get(d.date)}`
        : null,
    })),
    links: {
      site: `${origin}/`,
      reserve: `${origin}/reserve`,
      // カレンダーのモード (レンタル / スポーツ走行) で入口を変えるため
      rp: `${origin}/reserve/rp`,
      sport: `${origin}/reserve/sport`,
      event: `${origin}/reserve/event`,
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
