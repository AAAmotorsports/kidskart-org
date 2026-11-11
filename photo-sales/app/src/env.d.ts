/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  DB: D1Database;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  PUBLIC_SITE_NAME?: string;
  PUBLIC_BASE_URL?: string;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  CRON_SECRET?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  ORIGINALS: R2Bucket;
  PREVIEWS: R2Bucket;
  BACKUPS: R2Bucket;
}

declare namespace App {
  interface Locals extends Runtime {
    staff?: import('./lib/auth.ts').Staff;
  }
}

interface ImportMetaEnv extends Env {}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
