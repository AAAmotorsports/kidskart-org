import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import {
  fetchAllPaidAttendedParticipations, fetchPreAsmsMap,
  aggregate, buildCsv, fiscalYearRange,
} from '@lib/fiscalReport';

export const prerender = false;

// GET /api/admin/sales/fiscal-report
//   ?from=YYYY-MM&to=YYYY-MM  期間指定 (両端含む)
//   ?year=YYYY                会計年度 (4-3 月): year=2026 → 2026-04〜2027-03
//   format=csv (default) | json
//
// 福岡トヨペット向け年度報告の集計 (男女比率・年齢 3 区分・リピート率)。
// ロジックは src/lib/fiscalReport.ts 参照 (/admin/sales/fiscal-report ページと共有)。
// 氏名・カナ・電話・メール等 PII は一切出さない。

export const GET: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const supabase = getSupabaseAdmin(env);

  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const format = (url.searchParams.get('format') || 'csv').toLowerCase();

  let fromYm: string, toYm: string;
  if (yearParam && /^\d{4}$/.test(yearParam)) {
    const r = fiscalYearRange(parseInt(yearParam, 10));
    fromYm = r.fromYm;
    toYm = r.toYm;
  } else if (fromParam && toParam && /^\d{4}-\d{2}$/.test(fromParam) && /^\d{4}-\d{2}$/.test(toParam)) {
    fromYm = fromParam;
    toYm = toParam;
  } else {
    return new Response('from/to (YYYY-MM) または year=YYYY が必要です', { status: 400 });
  }

  let allRows: Awaited<ReturnType<typeof fetchAllPaidAttendedParticipations>>;
  try {
    allRows = await fetchAllPaidAttendedParticipations(supabase);
  } catch (e: any) {
    return new Response(`取得失敗: ${e?.message ?? e}`, { status: 500 });
  }

  const custIds = Array.from(new Set(
    allRows.map((r) => r.customer_id).filter((x): x is string => !!x),
  ));
  let preAsmsMap: Awaited<ReturnType<typeof fetchPreAsmsMap>>;
  try {
    preAsmsMap = await fetchPreAsmsMap(supabase, custIds);
  } catch (e: any) {
    return new Response(`customers 取得失敗: ${e?.message ?? e}`, { status: 500 });
  }

  const { months, buckets, total } = aggregate(allRows, fromYm, toYm, preAsmsMap);

  if (format === 'json') {
    return new Response(JSON.stringify({
      period: { fromYm, toYm },
      months: months.map((ym) => buckets.get(ym)!),
      total,
    }, null, 2), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const csv = buildCsv(months, buckets, total);
  const toDay = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const filename = `kidskart_report_${fromYm}_${toYm === toDay.slice(0, 7) ? 'now' : toYm}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
};
