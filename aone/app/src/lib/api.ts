// API ルート共通の小物。
import type { SupabaseClient } from '@supabase/supabase-js';
import { json } from './supabase';

/**
 * DB 側のドメインエラー (SQLSTATE 'AONE1') を HTTP に写像する。
 * hint に理由コードが入っている (class_full / rp_start_full / blocked ...)。
 */
export function mapRpcError(error: any): Response {
  const hint = error?.hint ?? '';
  const message = error?.message ?? '不明なエラー';

  if (error?.code === 'AONE1') {
    const status =
      hint === 'not_found' ? 404 :
      hint === 'bad_request' || hint === 'missing_name' || hint === 'min_party' ||
      hint === 'bad_start_time' || hint === 'past_date' ? 400 :
      409; // class_full / rp_start_full / blocked / charter_confirmed / rp_saturated など
    return json({ error: message, reason: hint }, status);
  }

  console.warn('[rpc] 予期しない DB エラー', error);
  return json({ error: '処理に失敗しました', detail: message }, 500);
}

/** RPC を叩いて、失敗ならそのまま返せる Response を返す */
export async function callRpc(
  supabase: SupabaseClient,
  fn: string,
  payload: Record<string, unknown>,
): Promise<{ data?: any; response?: Response }> {
  const { data, error } = await supabase.rpc(fn, { payload });
  if (error) return { response: mapRpcError(error) };
  return { data };
}

/**
 * Supabase の設定が揃っているか。未設定なら 503 を返す Response を返す
 * (セットアップ途中でも 500 にせず、原因が分かる形で止める)。
 */
export function notConfigured(env: Env): Response | null {
  if (!env.PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({
      error: '予約システムの設定が未完了です',
      detail: 'PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を設定してください',
    }, 503);
  }
  return null;
}

/** リクエスト URL からオリジン (https://host) を取り出す */
export function originOf(request: Request): string {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Cloudflare Workers でレスポンス後も非同期処理 (メール送信) を続ける。
 * ローカル dev では ctx が無いので、その場で await されないまま流す。
 */
export function keepAlive(locals: App.Locals, promise: Promise<unknown>): void {
  const ctx = (locals as any)?.runtime?.ctx;
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  } else {
    promise.catch((e) => console.warn('[keepAlive] 非同期処理が失敗', e));
  }
}

/** 文字列フィールドの取り出し (空文字は undefined 扱い) */
export function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? undefined : s;
}

export function isEmail(v: string | undefined): v is string {
  return !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
