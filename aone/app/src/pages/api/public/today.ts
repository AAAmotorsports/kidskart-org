import type { APIRoute } from 'astro';
import { envFrom, json } from '@lib/supabase';
import { dayState } from '@lib/queries';
import {
  todayJst, jaDate, STATUS_MARK, WEATHER_LABELS, categoryText, BLOCK_KIND_LABELS,
} from '@lib/domain';

export const prerender = false;

// GET /api/public/today
//
// rk-a1.com (WordPress) に「今日走れる？」を表示させるための公開 API。
// iframe で予約アプリごと埋め込むのではなく、WordPress 側がこの JSON を読んで
// 自前の見た目で描画する — ホームページの見た目を保ったままデータだけ同期する。
//
// 返すのは集計結果だけ。予約者の氏名・連絡先は一切含めない。
// (今の手入力スケジュールは RP 予約者の実名が公開されているが、それはやめる)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const OPTIONS: APIRoute = () => new Response(null, { status: 204, headers: CORS });

export const GET: APIRoute = async ({ url, locals, request }) => {
  const env = envFrom(locals);
  const date = url.searchParams.get('date') || todayJst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date は YYYY-MM-DD 形式で指定してください' }, 400);
  }

  const state = await dayState(env, date);
  if (!state) {
    return new Response(JSON.stringify({ error: '状況を取得できませんでした' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    });
  }

  const origin = new URL(request.url).origin;
  const sessions = (['am', 'pm'] as const).map((key) => {
    const s = state.sport[key];
    return {
      key,
      label: key === 'am' ? '午前' : '午後',
      time: `${s.start_time}〜${s.end_time}`,
      used_classes: s.used_classes,
      max_classes: s.max_classes,
      accepting: s.accepting,
      // カート・ミニバイクは常に表示。キッズ・その他は事前予約制なので、
      // 予約が入っている日だけ出す (index.astro と同じルール)。
      categories: s.categories
        .filter((c) => !c.requires_reservation || c.running)
        .map((c) => ({
        code: c.code,
        name: c.name,
        short_name: c.short_name,
        status: c.status,
        mark: STATUS_MARK[c.status],
        text: categoryText(c),
        walk_in_ok: c.walk_in_ok,
        requires_reservation: c.requires_reservation,
        running: c.running,
      })),
      // 予約が入っていないため非表示にしたカテゴリー (WordPress 側で
      // 「キッズは要予約です」と案内したいとき用)
      hidden_categories: s.categories
        .filter((c) => c.requires_reservation && !c.running)
        .map((c) => ({ code: c.code, name: c.name, short_name: c.short_name })),
    };
  });

  const openSlots = state.rp.slots.filter((s) => s.accepting);
  const rp = {
    min_party: state.rp.min_party,
    open_count: openSlots.length,
    total_count: state.rp.slots.length,
    first_open: openSlots[0]?.time ?? null,
    summary:
      openSlots.length === 0
        ? '本日は満枠です'
        : openSlots.length === state.rp.slots.length
          ? `${openSlots[0].time}〜${openSlots[openSlots.length - 1].time} すべて空きあり`
          : `${openSlots[0].time}〜 空きあり (残り ${openSlots.length} 枠)`,
    slots: state.rp.slots.map((s) => ({ time: s.time, accepting: s.accepting })),
  };

  return new Response(JSON.stringify({
    date: state.date,
    label: jaDate(state.date),
    is_holiday: state.is_holiday,
    hours: state.hours,
    weather: {
      status: state.weather.status,
      label: WEATHER_LABELS[state.weather.status] ?? state.weather.status,
      message: state.weather.message,
      open: state.weather.status !== 'cancelled',
    },
    sessions,
    rp,
    blocks: state.blocks
      .filter((b) => b.is_public)
      .map((b) => ({
        label: b.public_label,
        kind: b.kind,
        kind_label: BLOCK_KIND_LABELS[b.kind] ?? b.kind,
        start_time: b.start_time,
        end_time: b.end_time,
      })),
    links: {
      site: `${origin}/`,
      reserve: `${origin}/reserve`,
      sport: `${origin}/reserve/sport`,
      rp: `${origin}/reserve/rp`,
      charter: `${origin}/reserve/charter`,
      night: `${origin}/reserve/night`,
      schedule: `${origin}/schedule`,
    },
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      ...CORS,
    },
  });
};
