// =============================================================================
// freee API 連携ヘルパー
// -----------------------------------------------------------------------------
// ASMS → freee 月次売上同期で使う:
//   1. OAuth refresh_token から access_token を取得 (ローテーション対応)
//   2. 月次売上を freee の income deal として登録 (冪等性チェック付き)
//
// 同じ会社の既存連携: invoice-system/scripts/freee-sync.js
//   (SHOPFLOW 請求書 → freee)。本ファイルはそれを ASMS 用に型安全に移植。
//
// refresh_token のローテーション戦略 (invoice-system と同じ):
//   1. 優先: freee_oauth_state.refresh_token (DB)
//   2. それが invalid_grant で失敗したら: Worker Secret FREEE_REFRESH_TOKEN
//   3. 成功した時に返ってきた新 refresh_token を DB に書き戻す
// Cloudflare Secret は Worker から書き換えられないので DB で持つ必要がある。
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

const FREEE_API = 'https://api.freee.co.jp';
const FREEE_TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

// 福岡キッズカートアカデミー固定の設定 (運用で変わるものではない)
export const FREEE_CONFIG = {
  companyId:        28630,
  // 勘定科目
  accountItemId:    4366958,  // 売上高
  // 税コード
  taxCode:          129,      // 課税売上10%
  // 品目
  itemId:           4443465,  // カート教室
  // 取引先
  partnerId:        64971,    // カート教室売上
  // 口座 (walletable)
  cashWalletId:     31189,    // 現金
  paypayWalletId:   2246019,  // paypay
} as const;

export interface FreeeEnv {
  FREEE_CLIENT_ID?: string;
  FREEE_CLIENT_SECRET?: string;
  FREEE_REFRESH_TOKEN?: string;
}

// -----------------------------------------------------------------------------
// Token exchange
// -----------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

class InvalidGrantError extends Error {
  constructor(public body: string) {
    super(`freee invalid_grant: ${body.slice(0, 200)}`);
  }
}

async function exchangeRefreshToken(
  env: FreeeEnv,
  refreshToken: string,
): Promise<TokenResponse> {
  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET) {
    throw new Error('FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が未設定です');
  }
  const res = await fetch(FREEE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && text.includes('invalid_grant')) {
      throw new InvalidGrantError(text);
    }
    throw new Error(`freee token refresh failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

/**
 * access_token を 1 つ取得する。
 *   1. DB の refresh_token を優先
 *   2. invalid_grant なら DB をクリアして Worker Secret にフォールバック
 *   3. ローテーションされた新 refresh_token を DB に書き戻し
 */
export async function getFreeeAccessToken(
  supabase: SupabaseClient,
  env: FreeeEnv,
): Promise<string> {
  // 1st: DB
  const { data: stateRow } = await supabase
    .from('freee_oauth_state')
    .select('refresh_token')
    .eq('singleton', true)
    .maybeSingle();
  const dbToken: string | null = stateRow?.refresh_token ?? null;

  if (dbToken) {
    try {
      const data = await exchangeRefreshToken(env, dbToken);
      await persistRotatedToken(supabase, data.refresh_token);
      return data.access_token;
    } catch (e) {
      if (!(e instanceof InvalidGrantError)) throw e;
      console.warn('[freee] DB refresh_token invalid → fallback to Worker Secret');
      await supabase
        .from('freee_oauth_state')
        .upsert({
          singleton: true,
          refresh_token: null,
          invalidated_at: new Date().toISOString(),
        }, { onConflict: 'singleton' });
    }
  }

  // 2nd: Worker Secret
  if (!env.FREEE_REFRESH_TOKEN) {
    throw new Error('FREEE_REFRESH_TOKEN が未設定で、DB にも有効な token が無い');
  }
  const data = await exchangeRefreshToken(env, env.FREEE_REFRESH_TOKEN);
  await persistRotatedToken(supabase, data.refresh_token);
  return data.access_token;
}

async function persistRotatedToken(supabase: SupabaseClient, newToken: string): Promise<void> {
  const { error } = await supabase
    .from('freee_oauth_state')
    .upsert({
      singleton: true,
      refresh_token: newToken,
      updated_at: new Date().toISOString(),
      invalidated_at: null,
    }, { onConflict: 'singleton' });
  if (error) {
    // DB 書き込み失敗は致命ではないが次回ローテーションでズレる。
    // ログだけ出して処理は続行 (今回取得した access_token は使える)。
    console.warn('[freee] failed to persist rotated refresh_token:', error.message);
  }
}

// -----------------------------------------------------------------------------
// Deal API
// -----------------------------------------------------------------------------

async function freeeApi<T = any>(
  method: 'GET' | 'POST',
  path: string,
  accessToken: string,
  body?: unknown,
  query?: Record<string, string | number>,
): Promise<T> {
  let url = `${FREEE_API}${path}`;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    if (qs) url += `?${qs}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Api-Version': '2020-06-15',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`freee ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) as T : ({} as T);
}

interface DealDetail {
  account_item_id: number;
  tax_code: number;
  item_id?: number;
  amount: number;
  description?: string;
  entry_side: 'credit' | 'debit';
}

interface FreeeDeal {
  id: number;
  ref_number: string | null;
  amount: number;
  issue_date: string;
}

/**
 * ref_number で既存 deal を検索。
 * freee の /api/1/deals は ref_number の完全一致検索を直接サポートしないので、
 * issue_date の前後 7 日を窓にして ref_number 一致を手で絞る。
 */
async function findDealByRefNumber(
  accessToken: string,
  refNumber: string,
  issueDate: string,
): Promise<FreeeDeal | null> {
  const d = new Date(`${issueDate}T00:00:00Z`);
  const from = new Date(d.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const to   = new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const res = await freeeApi<{ deals: FreeeDeal[] }>(
    'GET', '/api/1/deals', accessToken, null,
    {
      company_id: FREEE_CONFIG.companyId,
      type: 'income',
      start_issue_date: from,
      end_issue_date: to,
      limit: 100,
    },
  );
  return (res.deals ?? []).find(d => d.ref_number === refNumber) ?? null;
}

export interface MonthlyDealInput {
  /** 'cash' or 'paypay' */
  paymentMethod: 'cash' | 'paypay';
  /** 月末日 (YYYY-MM-DD, 発生主義で前月末に計上) */
  issueDate: string;
  /** 'YYYY-MM' (description と ref_number に使う) */
  ym: string;
  /** 合計金額 (yen, > 0) */
  amount: number;
  /** 件数 (description に埋める参考情報) */
  count: number;
}

export interface MonthlyDealResult {
  dealId: number;
  skipped: boolean;    // 既存 deal を再利用した
  refNumber: string;
}

/**
 * 月次売上 deal を作成する (冪等)。
 * ref_number 一致の既存 deal があり金額も一致すれば skip して既存 id を返す。
 * 金額が違う場合はエラー (手動確認が必要なため勝手に修正しない)。
 */
export async function ensureMonthlyDeal(
  accessToken: string,
  input: MonthlyDealInput,
): Promise<MonthlyDealResult> {
  const label = input.paymentMethod === 'cash' ? '現金' : 'PayPay';
  const walletId = input.paymentMethod === 'cash'
    ? FREEE_CONFIG.cashWalletId
    : FREEE_CONFIG.paypayWalletId;
  const refNumber = `KS-${input.ym}-${input.paymentMethod.toUpperCase()}`;
  const description = `【ASMS】カート教室 ${label}売上 ${input.ym} (${input.count}件)`;

  // 冪等性チェック
  const existing = await findDealByRefNumber(accessToken, refNumber, input.issueDate);
  if (existing) {
    if (existing.amount === input.amount) {
      return { dealId: existing.id, skipped: true, refNumber };
    }
    throw new Error(
      `既存 deal (id=${existing.id}, ref=${refNumber}) と金額が不一致: ` +
      `freee=¥${existing.amount.toLocaleString()} vs ASMS=¥${input.amount.toLocaleString()}。` +
      ` freee 側で直すか、既存 deal を手動削除してから再実行してください。`,
    );
  }

  // 新規作成 (settled: 発生と入金を同じ日で記録 — 現金商売なので当日入金)
  const details: DealDetail[] = [{
    account_item_id: FREEE_CONFIG.accountItemId,
    tax_code: FREEE_CONFIG.taxCode,
    item_id: FREEE_CONFIG.itemId,
    amount: input.amount,
    description,
    entry_side: 'credit',
  }];

  const createRes = await freeeApi<{ deal: FreeeDeal }>(
    'POST', '/api/1/deals', accessToken,
    {
      company_id: FREEE_CONFIG.companyId,
      issue_date: input.issueDate,
      type: 'income',
      ref_number: refNumber,
      partner_id: FREEE_CONFIG.partnerId,
      details,
      payments: [{
        amount: input.amount,
        from_walletable_type: 'wallet',
        from_walletable_id: walletId,
        date: input.issueDate,
      }],
    },
  );
  return { dealId: createRes.deal.id, skipped: false, refNumber };
}
