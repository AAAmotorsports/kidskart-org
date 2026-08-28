// =============================================================================
// Cloudflare Worker entry (fetch + scheduled)
// -----------------------------------------------------------------------------
// Astro が生成する dist/_worker.js/index.js は fetch handler だけを export
// する。Cloudflare Workers Cron Triggers を使うには scheduled handler も必要
// なので、この薄いラッパで両方を提供する。
//
// wrangler.jsonc の `main` はこのファイルを指す (Astro build の出力を import
// して再エクスポート)。
//
// cron の役割:
//   09:00 UTC (18:00 JST): /api/cron/thankyou-mail   ← 前日分キャッチアップ含む
//   09:30 UTC (18:30 JST): /api/cron/reminder-mail   ← 翌日のリマインド
//   10:00 UTC (19:00 JST): /api/cron/followup-mail   ← 30 日前参加者
//
// GitHub Actions cron は停止済み (workflow_dispatch のみ残す)。Cloudflare
// Workers Cron Triggers は GitHub Actions より遥かに時刻精度が高い
// (秒〜分レベル)。
//
// 二重送信防止は各 API の DB フラグ (thankyou_email_sent_at 等) で担保。
// 万一 GitHub Actions と Cloudflare 両方が同時発火しても、DB の
// idempotency で 2 通目は送られない。
// -----------------------------------------------------------------------------
import astroWorker from './dist/_worker.js/index.js';

const CRON_TO_ENDPOINT = {
  '0 9 * * *':  '/api/cron/thankyou-mail',   // 18:00 JST
  '30 9 * * *': '/api/cron/reminder-mail',   // 18:30 JST
  '0 10 * * *': '/api/cron/followup-mail',   // 19:00 JST
};

export default {
  fetch(request, env, ctx) {
    return astroWorker.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const endpoint = CRON_TO_ENDPOINT[event.cron];
    const startedAt = new Date().toISOString();
    if (!endpoint) {
      console.warn(`[cron] unknown schedule: "${event.cron}" at ${startedAt}`);
      return;
    }
    console.log(`[cron] START ${event.cron} → ${endpoint} at ${startedAt}`);

    // ダミーの URL でも Astro 側は path で routing するので host は何でもいい。
    // ここでは 本番ドメイン名にしておくと、API 内で origin 参照する時に
    // reserve.kidskart.org になって正しい URL が生成される。
    const request = new Request(`https://reserve.kidskart.org${endpoint}`, {
      method: 'POST',
      headers: {
        'x-cron-secret': env.CRON_SECRET || '',
        'Content-Type': 'application/json',
      },
    });

    try {
      const response = await astroWorker.fetch(request, env, ctx);
      const bodyText = await response.text();
      const bodyPreview = bodyText.slice(0, 500);
      if (!response.ok) {
        console.error(`[cron] FAIL ${endpoint} HTTP ${response.status}: ${bodyPreview}`);
        // throw して Cloudflare 側の failed invocations カウンタを増やす
        // (Dashboard で見える)。retry は自動されないが観測性は上がる。
        throw new Error(`Cron ${endpoint} returned HTTP ${response.status}`);
      }
      // 成功時: 送信件数・スキップ件数などのサマリを含む JSON がそのまま出る
      console.log(`[cron] DONE ${endpoint} OK: ${bodyPreview}`);
    } catch (e) {
      console.error(`[cron] EXCEPTION ${endpoint}: ${e?.message ?? e}`);
      throw e;
    }
  },
};
