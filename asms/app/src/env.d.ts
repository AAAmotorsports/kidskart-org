/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  RESEND_API_KEY?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  MAIL_REPLY_TO?: string;
  MAIL_ADMIN_TO?: string;

  PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;

  PUBLIC_APP_URL?: string;
  PUBLIC_RESERVE_PATH?: string;

  // 予約当日サンキューメール内のご感想アンケートリンク (Google Form 等)
  // 未設定なら本文からアンケートセクションを省略する。
  PUBLIC_SURVEY_URL?: string;

  // /api/cron/* を GitHub Actions cron 等から叩くときの共有シークレット
  // Cloudflare Dashboard の Secret として設定する。
  CRON_SECRET?: string;

  // Google Analytics 4 の測定 ID (例: G-XXXXXXXXXX)。
  // wrangler.jsonc の vars に入れる → Base.astro が読み gtag を挿入する。
  // 空文字 / 未設定なら計測タグを一切吐かない。
  PUBLIC_GA4_MEASUREMENT_ID?: string;

  // Google Business Profile の口コミ投稿 URL。サンキューメールで
  // 「初回参加 & 未依頼」の保護者に 1 度だけ CTA として出す。
  // 空文字なら口コミセクションを省略。
  PUBLIC_GOOGLE_REVIEW_URL?: string;

  // Simple admin gate for MVP — will be replaced by Supabase Auth later.
  // Password is stored as a SHA-256 hex digest so the plain value never
  // leaves the operator's machine.
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;

  // freee API 連携 (ASMS → freee 月次売上同期用、/api/cron/freee-sync-monthly)。
  // Cloudflare Dashboard の Secret として設定する。
  // 初回の FREEE_REFRESH_TOKEN は手動で払い出した値を入れる。以降は
  // freee_oauth_state テーブルに格納されたローテ後の値を優先的に使う。
  FREEE_CLIENT_ID?: string;
  FREEE_CLIENT_SECRET?: string;
  FREEE_REFRESH_TOKEN?: string;

  // R2 bucket binding (kidskart-asms-backup) for backup monitoring on
  // /admin. Read-only usage from the Worker; writes are still done by
  // GitHub Actions cron (asms-db-backup.yml) via S3-compatible API.
  BACKUP_BUCKET?: R2Bucket;
}

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv extends Env {}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
