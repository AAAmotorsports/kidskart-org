import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// GET /api/admin/sales/export-monthly?year=2026&from=2026-09&to=2026-12
//
// 旧 Reserva の「期間別集計 (月別)」CSV と同じ 10 列フォーマットで書き出す。
// 連結して Numbers / Excel に取り込めば、旧システム分と新システム分を
// 時系列で並べられる。
//
// パラメータ:
//   - year: 単年分 (YYYY) 1〜12 月全部
//   - from/to: 範囲指定 (YYYY-MM)
//   - なし: 今年の 1 月 〜 今月
//
// 月の帰属は paid_at (JST) ベース。会計を打った月に計上する (freee 月次同期と同じ)。
//
// 列定義 (Reserva と同じ):
//   1. 集計期間 (YYYYMM)
//   2. 売上 — SUM(paid_amount)
//   3. 会計数 — COUNT(reservations) with paid_at NOT NULL
//   4. 会計単価 — ROUND(売上 / 会計数)
//   5. 客数 — ASMS では 1 予約 = 1 客扱い (Reserva と同じ数え方)
//   6. 客単価 — 会計単価と同値
//   7. 商品数 — SUM(active participants per paid reservation) — 「子の人数」
//   8. 現金支払合計額 — SUM(paid_amount) WHERE payment_method='cash'
//   9. 現金その他支払合計額 — SUM(paid_amount) WHERE payment_method IN ('paypay','credit')
//   10. 割引額 — SUM(total_amount - paid_amount) WHERE paid_amount < total_amount

export const GET: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  // 期間決定 (YYYY-MM 文字列の from / to、両端含む)
  let fromYm: string, toYm: string;
  if (yearParam && /^\d{4}$/.test(yearParam)) {
    fromYm = `${yearParam}-01`;
    toYm = `${yearParam}-12`;
  } else if (fromParam && toParam && /^\d{4}-\d{2}$/.test(fromParam) && /^\d{4}-\d{2}$/.test(toParam)) {
    fromYm = fromParam;
    toYm = toParam;
  } else {
    fromYm = `${curYear}-01`;
    toYm = `${curYear}-${String(curMonth).padStart(2, '0')}`;
  }

  // 月リストを展開
  const months: string[] = [];
  {
    const [fy, fm] = fromYm.split('-').map(Number);
    const [ty, tm] = toYm.split('-').map(Number);
    let y = fy, m = fm;
    while (y < ty || (y === ty && m <= tm)) {
      months.push(`${y}-${String(m).padStart(2, '0')}`);
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  // Supabase の範囲クエリ用 ISO (JST → UTC で -9h)
  function jstMidnightUtcIso(y: number, mo: number, d: number): string {
    return new Date(Date.UTC(y, mo - 1, d, -9, 0, 0)).toISOString();
  }
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  const startIso = jstMidnightUtcIso(fy, fm, 1);
  const endIso = jstMidnightUtcIso(ty, tm + 1, 1);

  // 会計済み予約を期間で取得 (paid_at 基準)
  const { data: rowsRaw, error } = await supabase
    .from('reservations')
    .select(`
      id, paid_at, paid_amount, payment_method, total_amount,
      reservation_participants(id, attendance_status)
    `)
    .not('paid_at', 'is', null)
    .gte('paid_at', startIso)
    .lt('paid_at', endIso);
  if (error) {
    return new Response(`query error: ${error.message}`, { status: 500 });
  }
  const rows = (rowsRaw ?? []) as any[];

  // 月別 bucket 初期化
  type Bucket = {
    sales: number;        // 売上
    txCount: number;      // 会計数
    itemCount: number;    // 商品数 (active participants)
    cash: number;         // 現金
    nonCash: number;      // 現金その他
    discount: number;     // 割引額
  };
  const buckets = new Map<string, Bucket>();
  for (const ym of months) {
    buckets.set(ym, {
      sales: 0, txCount: 0, itemCount: 0, cash: 0, nonCash: 0, discount: 0,
    });
  }

  for (const r of rows) {
    // paid_at の JST 月を算出
    const paidAt = r.paid_at as string;
    const dJst = new Date(new Date(paidAt).getTime() + 9 * 3600 * 1000);
    const ym = `${dJst.getUTCFullYear()}-${String(dJst.getUTCMonth() + 1).padStart(2, '0')}`;
    const b = buckets.get(ym);
    if (!b) continue;

    const paid = Number(r.paid_amount ?? 0);
    const total = Number(r.total_amount ?? 0);
    const activeParts = ((r.reservation_participants ?? []) as any[])
      .filter((p) => p.attendance_status !== 'cancelled').length;

    b.sales += paid;
    b.txCount += 1;
    b.itemCount += activeParts;
    if (r.payment_method === 'cash') b.cash += paid;
    else b.nonCash += paid;
    // 割引: total_amount より paid_amount が少なければ差額を割引額に加算
    if (total > paid) b.discount += total - paid;
  }

  // CSV 組み立て (UTF-8 BOM を付けて Excel での文字化け回避)
  const header = [
    '集計期間', '売上', '会計数', '会計単価',
    '客数', '客単価', '商品数',
    '現金支払合計額', '現金その他支払合計額', '割引額',
  ].join(',');
  const lines = [header];
  for (const ym of months) {
    const b = buckets.get(ym)!;
    const yyyymm = ym.replace('-', '');
    const unit = b.txCount > 0 ? Math.round(b.sales / b.txCount) : 0;
    // Reserva と列並びを合わせる: 会計数 = 客数、会計単価 = 客単価
    lines.push([
      yyyymm,
      b.sales,
      b.txCount,
      unit,
      b.txCount,
      unit,
      b.itemCount,
      b.cash,
      b.nonCash,
      b.discount,
    ].join(','));
  }

  const bom = '﻿';
  const csv = bom + lines.join('\n') + '\n';
  const filename = `asms-sales-${fromYm}_${toYm}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};
