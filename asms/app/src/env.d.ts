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

  PUBLIC_TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;

  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;

  PUBLIC_APP_URL?: string;
  PUBLIC_RESERVE_PATH?: string;

  // Simple admin gate for MVP — will be replaced by Supabase Auth later
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}

declare namespace App {
  interface Locals extends Runtime {}
}

interface ImportMetaEnv extends Env {}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
