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

export default {
  fetch: (request, env, ctx) => astro.fetch(request, env, ctx),

  async scheduled(event, env, ctx) {
    // 何時に何をやるかは tasks.js が決める (Node からテストできるように分けてある)
    const { stamp, tasks } = planFor(event.scheduledTime);

    // 仕事が無い時間でも 1 行残す。何も出ないと「cron が動いていないのか、
    // その時間は何も無いのか」が Logs から見分けられない
    if (tasks.length === 0) {
      console.log(`[cron] ${stamp} JST — この時間は送るものがありません (次は 8/12/18 時)`);
      return;
    }

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
