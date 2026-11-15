import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// GET /api/admin/sales/export-monthly?year=2026&from=2026-09&to=2026-12&basis=paid|slot
//
// Airレジの「期間別集計 (月別)」CSV と同じ 10 列フォーマットで書き出す。
// 連結して Numbers / Excel に取り込めば、旧システム分と新システム分を
// 時系列で並べられる。
//
// パラメータ:
//   - year: 単年分 (YYYY) 1〜12 月全部
//   - from/to: 範囲指定 (YYYY-MM)
//   - なし: 今年の 1 月 〜 今月 (JST)
//   - basis: 月の帰属基準
//     - 'paid' (default): paid_at (JST) の月に計上。会計・freee 連携と整合。
//                         事前決済だと参加月とズレるので、売上管理用。
//     - 'slot':           slots.date (JST) の月に計上。「何月に何人来たか」の
//                         参加実績レポート用。年度集計はこちらが素直。
//
// 列定義 (Airレジと同じ):
//   1. 集計期間 (YYYYMM)
//   2. 売上 — SUM(paid_amount)
//   3. 会計数 — COUNT(reservations) with paid_at NOT NULL
//   4. 会計単価 — ROUND(売上 / 会計数)
//   5. 客数 — ASMS では 1 予約 = 1 客扱い (Airレジ同じ数え方)
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
  const basisParam = (url.searchParams.get('basis') || 'paid').toLowerCase();
  const basis: 'paid' | 'slot' = basisParam === 'slot' ? 'slot' : 'paid';

  // 現在時刻は JST で評価 (UTC で評価すると日本の 0:00〜9:00 に月跨ぎ事故)
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const curYear = nowJst.getUTCFullYear();
  const curMonth = nowJst.getUTCMonth() + 1;

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
  const startDate = `${fy}-${String(fm).padStart(2, '0')}-01`;
  const endMonth = tm === 12 ? { y: ty + 1, m: 1 } : { y: ty, m: tm + 1 };
  const endDateExcl = `${endMonth.y}-${String(endMonth.m).padStart(2, '0')}-01`;

  // ページネーションで全件取得する (Supabase の default 1000 件制限を越える)
  // Cloudflare Worker の CPU 時間は短いので、range() で順次 fetch し concat する。
  const PAGE = 1000;
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    let q = supabase
      .from('reservations')
      .select(`
        id, paid_at, paid_amount, payment_method, total_amount, status,
        slots(date),
        reservation_participants(id, attendance_status)
      `);
    if (basis === 'paid') {
      q = q
        .not('paid_at', 'is', null)
        .gte('paid_at', startIso)
        .lt('paid_at', endIso);
    } else {
      // slot 基準: 開催日が範囲内の予約 (キャンセル除く)
      q = q
        .neq('status', 'cancelled')
        .gte('slots.date', startDate)
        .lt('slots.date', endDateExcl);
    }
    q = q.range(offset, offset + PAGE - 1);
    const { data, error } = await q;
    if (error) {
      return new Response(`query error: ${error.message}`, { status: 500 });
    }
    const batch = (data ?? []) as any[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
    // 無限ループ防止 (理論上 100,000 件で打ち切り)
    if (offset > 100_000) break;
  }

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
    // 月キー: basis に応じて paid_at or slots.date の JST 月を使う
    let ym: string;
    if (basis === 'paid') {
      const paidAt = r.paid_at as string;
      if (!paidAt) continue;
      const dJst = new Date(new Date(paidAt).getTime() + 9 * 3600 * 1000);
      ym = `${dJst.getUTCFullYear()}-${String(dJst.getUTCMonth() + 1).padStart(2, '0')}`;
    } else {
      // slot.date は YYYY-MM-DD の文字列 (JST)
      const slotDate = r.slots?.date as string | undefined;
      if (!slotDate || !/^\d{4}-\d{2}-\d{2}$/.test(slotDate)) continue;
      ym = slotDate.slice(0, 7);
    }
    const b = buckets.get(ym);
    if (!b) continue;

    const isPaid = !!r.paid_at;
    const paid = Number(r.paid_amount ?? 0);
    const total = Number(r.total_amount ?? 0);
    const activeParts = ((r.reservation_participants ?? []) as any[])
      .filter((p) => p.attendance_status !== 'cancelled').length;

    // 売上・会計数・現金/その他・割引は会計済だけ計上 (未会計を混ぜない)
    if (isPaid) {
      b.sales += paid;
      b.txCount += 1;
      if (r.payment_method === 'cash') b.cash += paid;
      else b.nonCash += paid;
      // 割引: total_amount より paid_amount が少なければ差額を加算
      // (paid_at が set されたうえで paid < total は当日値引 or 無料扱い)
      if (total > paid) b.discount += total - paid;
    }
    // 商品数 (参加者数) は slot basis では会計未完了も含めて数える
    // (参加実績の報告が主用途なので「何人参加したか」を正しく出す)
    if (basis === 'slot' || isPaid) {
      b.itemCount += activeParts;
    }
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
    // Airレジと列並びを合わせる: 会計数 = 客数、会計単価 = 客単価
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
  const basisSuffix = basis === 'slot' ? '_slot' : '_paid';
  const filename = `asms-sales-${fromYm}_${toYm}${basisSuffix}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};
