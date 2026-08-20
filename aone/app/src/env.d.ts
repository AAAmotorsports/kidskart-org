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

  PUBLIC_SITE_NAME?: string;
  PUBLIC_SITE_TEL?: string;
  PUBLIC_GA4_MEASUREMENT_ID?: string;

  /** 気象庁 予報エリアコード (福岡県 = 400000)。管理画面の参考情報用 */
  JMA_AREA_CODE?: string;
  JMA_AREA_NAME?: string;

  /** /api/cron/* を GitHub Actions から叩くときの共有シークレット */
  CRON_SECRET?: string;

  /** 管理画面の Basic 認証 (ADMIN_PASSWORD_HASH は SHA-256 hex) */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD_HASH?: string;
}

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv extends Env {}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
