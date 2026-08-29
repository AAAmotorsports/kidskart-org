/**
 * Worker のエントリ — Astro が生成したハンドラに cron (scheduled) を足す。
 *
 * なぜラップするのか:
 *   @astrojs/cloudflare が出す dist/_worker.js/index.js は fetch ハンドラしか
 *   持たない。Cloudflare Cron Triggers は scheduled ハンドラを呼ぶので、
 *   生成物をそのまま main にすると cron が動かせない。
 *   ここで default export に scheduled を足して main をこちらに向ける。
 *
 * ★ fetch はそのまま素通しする。ここに処理を足さないこと
 *   (足すと「サイトが落ちる原因がここにもある」状態になる)。
 */
import astro from '../dist/_worker.js/index.js';
import { planFor } from './tasks.js';

/** ログに残した本文を JSON として読み直す (読めなければそのまま短く残す) */
function safeJson(text) {
  try { return JSON.parse(text); } catch { return { body: String(text).slice(0, 200) }; }
}

export default {
  fetch: (request, env, ctx) => astro.fetch(request, env, ctx),

  async scheduled(event, env, ctx) {
    // 何時に何をやるかは tasks.js が決める (Node からテストできるように分けてある)
    const { hour, day, stamp, tasks } = planFor(event.scheduledTime);
    const origin = (env.CRON_ORIGIN || 'https://reserve.rk-a1.com').replace(/\/$/, '');

    // 自分自身の fetch ハンドラを呼ぶ (外に出ないので速く、鍵も外に出ない)
    const call = (path) => astro.fetch(new Request(origin + path, {
      method: 'POST',
      headers: {
        'x-cron-secret': env.CRON_SECRET ?? '',
        'Content-Type': 'application/json',
      },
    }), env, ctx);

    const detail = [];
    for (const path of tasks) {
      try {
        const res = await call(path);
        const body = await res.text();
        console.log(`[cron] ${stamp} JST ${path} → HTTP ${res.status} ${body.slice(0, 500)}`);
        detail.push({ path, status: res.status, result: safeJson(body) });
      } catch (e) {
        console.error(`[cron] ${stamp} JST ${path} → 例外`, e?.stack ?? String(e));
        detail.push({ path, status: 0, error: String(e?.message ?? e) });
      }
    }

    if (tasks.length === 0) {
      // 仕事が無い時間でも 1 行残す。何も出ないと「cron が動いていないのか、
      // その時間は何も無いのか」が Logs から見分けられない
      console.log(`[cron] ${stamp} JST — この時間は送るものがありません (次は 8/12/18 時)`);
    }

    // 動いた記録を残す。**仕事が無い回も残す** — 記録が途切れたことが
    // 「止まった」の証拠になる。管理トップの「自動メール」欄がこれを読む
    try {
      const res = await astro.fetch(new Request(origin + '/api/cron/ping', {
        method: 'POST',
        headers: {
          'x-cron-secret': env.CRON_SECRET ?? '',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hour, day, detail }),
      }), env, ctx);
      if (!res.ok) console.warn(`[cron] ${stamp} JST 記録できませんでした HTTP ${res.status}`);
    } catch (e) {
      console.error(`[cron] ${stamp} JST 記録で例外`, e?.stack ?? String(e));
    }
  },
};
