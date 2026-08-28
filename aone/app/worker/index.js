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
import { tasksFor } from './tasks.js';

export default {
  fetch: (request, env, ctx) => astro.fetch(request, env, ctx),

  async scheduled(event, env, ctx) {
    // JST に直してから時・日を見る (Workers の時計は UTC)
    const jst = new Date(event.scheduledTime + 9 * 60 * 60 * 1000);
    const hour = jst.getUTCHours();
    const day = jst.getUTCDate();
    const stamp = jst.toISOString().slice(0, 16).replace('T', ' ');

    const tasks = tasksFor(hour, day);
    if (tasks.length === 0) return;

    const origin = (env.CRON_ORIGIN || 'https://reserve.rk-a1.com').replace(/\/$/, '');

    for (const path of tasks) {
      const url = origin + path;
      try {
        // 自分自身の fetch ハンドラを呼ぶ (外に出ないので速く、鍵も外に出ない)
        const res = await astro.fetch(new Request(url, {
          method: 'POST',
          headers: {
            'x-cron-secret': env.CRON_SECRET ?? '',
            'Content-Type': 'application/json',
          },
        }), env, ctx);
        const body = await res.text();
        console.log(`[cron] ${stamp} JST ${path} → HTTP ${res.status} ${body.slice(0, 500)}`);
      } catch (e) {
        console.error(`[cron] ${stamp} JST ${path} → 例外`, e?.stack ?? String(e));
      }
    }
  },
};
