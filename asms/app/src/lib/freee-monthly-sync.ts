// =============================================================================
// ASMS → freee 月次売上同期の中核ロジック
// -----------------------------------------------------------------------------
// 以下 2 つのエンドポイントから呼ばれる共通ヘルパー:
//   - /api/cron/freee-sync-monthly    (Cloudflare Cron 自動実行)
//   - /api/admin/sales-freee-sync     (admin 画面からの手動実行)
//
// 流れ:
//   1. 対象 YM (default: JST での「現在月の前月」) を決定
//   2. Supabase reservations から paid_at がその月に入る行を集計
//      (payment_method 別 amount / count)
//   3. monthly_freee_sync テーブルに現状の集計を upsert
//   4. 現金 / PayPay をそれぞれ freee に deal 作成 (ensureMonthlyDeal は冪等)
//   5. 結果を monthly_freee_sync に書き戻し (deal_id, status, error)
//
// エラー処理方針:
//   - 現金・PayPay は独立に成功/失敗できる (partial 状態がある)
//   - freee 側でエラーが出ても、Supabase 側は常に最新集計を upsert する
//     (= UI で「今の月の数字」が狂わない)
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ensureMonthlyDeal,
  getFreeeAccessToken,
  type FreeeEnv,
} from './freee';

export interface SyncResult {
  ym: string;
  startIso: string;
  endIso: string;
  issueDate: string;
  totals: {
    cash:   { amount: number; count: number };
    paypay: { amount: number; count: number };
    credit: { amount: number; count: number };
    other:  { amount: number; count: number };
  };
  cash:   LegResult;
  paypay: LegResult;
  status: 'success' | 'partial' | 'error' | 'skipped';
  message?: string;
}

export interface LegResult {
  attempted: boolean;
  skipped?: boolean;      // 既存 deal を再利用
  dealId?: number;
  refNumber?: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// 日付ヘルパー (JST 月境界 → UTC ISO)
// -----------------------------------------------------------------------------

function pad2(n: number) { return String(n).padStart(2, '0'); }

/** JST 月初 (00:00) を UTC ISO にする。 */
function jstMonthStartIso(y: number, m1: number): string {
  // Date.UTC(y, m-1, 1, -9, 0, 0) = JST 00:00 of day 1
  return new Date(Date.UTC(y, m1 - 1, 1, -9, 0, 0)).toISOString();
}

/** JST での「今月」から ym をとる。 */
function currentYmJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}`;
}

/** 'YYYY-MM' をデクリメント (2026-01 → 2025-12)。 */
function prevYm(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${pad2(m - 1)}`;
}

/** 'YYYY-MM' から {start, end, issue, year, month} を作る (JST 基準)。 */
function resolvePeriod(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const startIso = jstMonthStartIso(y, m);           // 当月 1 日 00:00 JST
  const endIso   = jstMonthStartIso(y, m + 1);       // 翌月 1 日 00:00 JST (half-open)
  // 月末日 (発生主義で前月末付で deal を記録する)
  const lastDay  = new Date(y, m, 0).getDate();       // local Date で day 0 of (m+1) = m 月末日
  const issueDate = `${y}-${pad2(m)}-${pad2(lastDay)}`;
  return { startIso, endIso, issueDate };
}

// -----------------------------------------------------------------------------
// 集計 (Supabase reservations → payment_method 別 totals)
// -----------------------------------------------------------------------------

async function aggregatePaidMonth(
  supabase: SupabaseClient,
  startIso: string,
  endIso: string,
): Promise<SyncResult['totals']> {
  const totals: SyncResult['totals'] = {
    cash:   { amount: 0, count: 0 },
    paypay: { amount: 0, count: 0 },
    credit: { amount: 0, count: 0 },
    other:  { amount: 0, count: 0 },
  };

  const { data, error } = await supabase
    .from('reservations')
    .select('payment_method, paid_amount')
    .not('paid_at', 'is', null)
    .gte('paid_at', startIso)
    .lt('paid_at', endIso);
  if (error) throw new Error(`reservations aggregate failed: ${error.message}`);

  for (const r of (data ?? []) as any[]) {
    const m: string = r.payment_method;
    const amt = Number(r.paid_amount ?? 0);
    if (!amt || !(m in totals)) continue;
    const bucket = totals[m as keyof typeof totals];
    bucket.amount += amt;
    bucket.count  += 1;
  }
  return totals;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface SyncOptions {
  /** 対象月 'YYYY-MM'。 省略時は JST 前月。 */
  ym?: string;
  /** cash/paypay が 0 円でも実行する (dry run に近い; 通常不要)。 */
  forceEmpty?: boolean;
}

/**
 * ASMS 月次売上を freee に同期する (冪等)。
 *
 * 1 ヶ月 1 回 Cron で実行、または admin 画面から手動実行する。
 */
export async function syncMonthlyFreeeDeals(
  supabase: SupabaseClient,
  env: FreeeEnv,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const ym = opts.ym ?? prevYm(currentYmJst());
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    throw new Error(`invalid ym: ${ym}`);
  }

  const { startIso, endIso, issueDate } = resolvePeriod(ym);

  // --- 集計 ---------------------------------------------------------------
  const totals = await aggregatePaidMonth(supabase, startIso, endIso);

  // --- 事前に Supabase 側 upsert (集計は常に最新に) --------------------
  const existingRow = await supabase
    .from('monthly_freee_sync')
    .select('*')
    .eq('ym', ym)
    .maybeSingle();
  const existing: any = existingRow.data ?? {};

  await supabase
    .from('monthly_freee_sync')
    .upsert({
      ym,
      cash_amount:    totals.cash.amount,
      cash_count:     totals.cash.count,
      paypay_amount:  totals.paypay.amount,
      paypay_count:   totals.paypay.count,
      credit_amount:  totals.credit.amount,
      credit_count:   totals.credit.count,
      other_amount:   totals.other.amount,
      other_count:    totals.other.count,
      status:         existing.status ?? 'pending',
      attempted_count: (existing.attempted_count ?? 0) + 1,
    }, { onConflict: 'ym' });

  // --- freee アクセストークン取得 (両方 0 円ならスキップ) ---------------
  const needCash   = totals.cash.amount   > 0 || opts.forceEmpty === true;
  const needPaypay = totals.paypay.amount > 0 || opts.forceEmpty === true;
  if (!needCash && !needPaypay) {
    await supabase.from('monthly_freee_sync').update({
      status: 'success',
      synced_at: new Date().toISOString(),
      error_message: null,
    }).eq('ym', ym);
    return {
      ym, startIso, endIso, issueDate, totals,
      cash:   { attempted: false },
      paypay: { attempted: false },
      status: 'success',
      message: '当月の対象売上なし (現金/PayPay とも 0 円)',
    };
  }

  let accessToken: string;
  try {
    accessToken = await getFreeeAccessToken(supabase, env);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    await supabase.from('monthly_freee_sync').update({
      status: 'error',
      error_message: `freee 認証エラー: ${msg}`.slice(0, 2000),
    }).eq('ym', ym);
    throw new Error(`freee 認証エラー: ${msg}`);
  }

  // --- 現金 ---------------------------------------------------------------
  const cash: LegResult = { attempted: needCash };
  if (needCash) {
    try {
      const r = await ensureMonthlyDeal(accessToken, {
        paymentMethod: 'cash',
        issueDate,
        ym,
        amount: totals.cash.amount,
        count:  totals.cash.count,
      });
      cash.dealId   = r.dealId;
      cash.refNumber = r.refNumber;
      cash.skipped  = r.skipped;
    } catch (e: any) {
      cash.error = e?.message ?? String(e);
    }
  }

  // --- PayPay -------------------------------------------------------------
  const paypay: LegResult = { attempted: needPaypay };
  if (needPaypay) {
    try {
      const r = await ensureMonthlyDeal(accessToken, {
        paymentMethod: 'paypay',
        issueDate,
        ym,
        amount: totals.paypay.amount,
        count:  totals.paypay.count,
      });
      paypay.dealId   = r.dealId;
      paypay.refNumber = r.refNumber;
      paypay.skipped  = r.skipped;
    } catch (e: any) {
      paypay.error = e?.message ?? String(e);
    }
  }

  // --- 結果判定 & 書き戻し ------------------------------------------------
  const cashOk   = !cash.attempted   || !!cash.dealId;
  const paypayOk = !paypay.attempted || !!paypay.dealId;
  const status: SyncResult['status'] =
    cashOk && paypayOk ? 'success'
    : (!cashOk && !paypayOk) ? 'error'
    : 'partial';

  const errorParts = [cash.error, paypay.error].filter(Boolean) as string[];
  const message = errorParts.length ? errorParts.join(' / ') : undefined;

  await supabase.from('monthly_freee_sync').update({
    status,
    cash_deal_id:   cash.dealId   ?? null,
    paypay_deal_id: paypay.dealId ?? null,
    error_message:  message ? message.slice(0, 2000) : null,
    synced_at:      new Date().toISOString(),
  }).eq('ym', ym);

  return { ym, startIso, endIso, issueDate, totals, cash, paypay, status, message };
}
