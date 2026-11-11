import type { Db } from './shop/db.ts';

export function getEnv(locals: App.Locals): Env {
  return (locals as any).runtime.env as Env;
}
export function getDb(locals: App.Locals): Db {
  return getEnv(locals).DB as unknown as Db;
}
/** メールのリンクなどに使う自分の URL (本番ドメインは PUBLIC_BASE_URL で後から設定) */
export function baseUrl(env: Env, request: Request): string {
  return (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '');
}
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export const redirect = (to: string, headers?: HeadersInit) =>
  new Response(null, { status: 303, headers: { location: to, ...(headers as object) } });
