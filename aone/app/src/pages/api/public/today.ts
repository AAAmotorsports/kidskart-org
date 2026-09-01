import type { APIRoute } from 'astro';
import { envFrom, json } from '@lib/supabase';
import { dayState, settings } from '@lib/queries';
import {
  todayJst, jaDate, STATUS_MARK, BUSINESS_LABELS, SURFACE_LABELS, categoryText,
  BLOCK_KIND_LABELS, blockLabel, dayFocus, openBadge, openNote,
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

  // 18 時 (コースクローズの 30 分後) を過ぎたら翌日を返す。
  // 営業が終わったあとに今日の空きを出しても、もう誰も来られない。
  // ?date= で明示された日はそのまま返す (時間帯は「準備中」扱い)。
  const asked = url.searchParams.get('date');
  const cfg = await settings(env);
  const focus = dayFocus({
    course_open: cfg?.course_open_time,
    course_close: cfg?.course_close_time,
  }, todayJst());
  const date = asked || focus.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date は YYYY-MM-DD 形式で指定してください' }, 400);
  }
  const phase = asked && asked !== focus.date ? 'before_open' : focus.phase;
  const isTomorrow = !asked && focus.is_tomorrow;

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
      label: key === 'am' ? 'AM' : 'PM',
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
  // 休業・走行中止の日は「満枠」ではなく「お休み」。枠が 0 なのは
  // 埋まっているからではないので、満枠と書くと誤解される (2026-08 オーナー指摘)
  const closedDay = ['cancelled', 'closed'].includes(state.business.status);
  const rp = {
    min_party: state.rp.min_party,
    open_count: openSlots.length,
    total_count: state.rp.slots.length,
    first_open: openSlots[0]?.time ?? null,
    summary:
      closedDay
        ? `${isTomorrow ? '明日' : '本日'}はお休みです`
        : openSlots.length === 0
        ? '本日は満枠です'
        : openSlots.length === state.rp.slots.length
          ? `${openSlots[0].time}〜${openSlots[openSlots.length - 1].time} 空きあり`
          : `${openSlots[0].time}〜 空きあり`,
    slots: state.rp.slots.map((s) => ({ time: s.time, accepting: s.accepting })),
  };

  const badge = openBadge(state.business.status, phase);

  return new Response(JSON.stringify({
    date: state.date,
    label: jaDate(state.date),
    is_holiday: state.is_holiday,
    hours: state.hours,
    // 時間帯 (準備中 / 営業中 / 本日は終了) と、翌日に切り替わっているか。
    // ★ 表示のためだけの情報。受付可否には一切かかわらない
    phase: {
      key: phase,
      label: badge.label,
      emoji: badge.emoji,
      tone: badge.tone,
      is_tomorrow: isTomorrow,
      day_word: isTomorrow ? '明日' : '本日',
      note: openNote(state.business.status, { ...focus, is_tomorrow: isTomorrow, phase },
                     state.hours.course_open),
      switch_time: focus.switch_time,
    },
    // 営業状況 (走れるかどうか) と路面状況 (どんな路面か) は別軸で返す
    business: {
      status: state.business.status,
      label: BUSINESS_LABELS[state.business.status] ?? state.business.status,
      message: state.business.message,
      open: !['cancelled', 'closed'].includes(state.business.status),
    },
    surface: state.surface.status ? {
      status: state.surface.status,
      label: SURFACE_LABELS[state.surface.status] ?? state.surface.status,
    } : null,
    sessions,
    rp,
    blocks: state.blocks
      .filter((b) => b.is_public)
      .map((b) => ({
        label: blockLabel(b.kind, b.public_label),
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
