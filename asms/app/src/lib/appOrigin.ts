// メール本文などに埋め込む「本番 origin」を一元化するヘルパ (2026-10-29 導入)。
//
// 背景:
// ASMS は 2 つのドメインで同じ Worker を提供している:
//   - reserve.kidskart.org             … 正式ドメイン (Custom Domain)
//   - kidskart-asms.kidskart1177.workers.dev … 旧 workers.dev (保守互換)
//
// もし顧客が旧 workers.dev 経由で予約した場合、サーバで `new URL(request.url).host`
// を使うと `kidskart-asms.kidskart1177.workers.dev` が入り、
// 管理者宛て通知メールや顧客向けメールのリンクが旧ドメインになる。
//
// 修正方針:
// wrangler.jsonc の vars に `PUBLIC_APP_URL=https://reserve.kidskart.org` を
// 設定し、全ての email generation site はこの関数を経由する。
// PUBLIC_APP_URL 未設定 (dev / preview) のときのみ request.url にフォールバック。

type RuntimeEnvLike = { PUBLIC_APP_URL?: string } | null | undefined;

/**
 * メール本文等に埋め込む origin (スキーム + ホスト、末尾スラッシュ無し)。
 * 本番では必ず `https://reserve.kidskart.org` を返す (wrangler.jsonc 設定経由)。
 */
export function canonicalOrigin(env: RuntimeEnvLike, request: Request): string {
  const configured = (env?.PUBLIC_APP_URL ?? '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}
