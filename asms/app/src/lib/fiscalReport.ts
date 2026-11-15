// =============================================================================
// 年度報告用 集計ロジック (福岡トヨペット向け例年レポートと同じ 3 項目)
//
// 対象:
//   - slots.date が指定期間内
//   - reservations.status != 'cancelled'
//   - reservation_participants.attendance_status != 'cancelled'
//   - reservations.paid_at IS NOT NULL (会計済)
//
// 数え方: 参加者 1 人 × 1 回 = 1 (兄弟は 2 でカウント)。
// /admin/sales の月別 CSV の「商品数」(slot basis) と合計が一致する設計。
//
// 集計:
//   1. 男女比率 — gender_snapshot で male/female/other
//   2. 年齢 (3 区分) — 参加日時点の年齢 (birth_date_snapshot と slots.date で計算)
//                     6 歳以下 / 7-9 歳 / 10 歳以上
//   3. リピート率 — 2 通り算出:
//      (a) 厳格: 同 customer_id に当日より前の参加があれば repeat
//      (b) 広め: 厳格判定 OR customers.pre_asms_visit_count > 0 OR
//                customers.pre_asms_first_visit_date IS NOT NULL
// =============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export type ReportRow = {
  customer_id: string | null;
  slot_date: string;        // YYYY-MM-DD
  gender: 'male' | 'female' | 'other' | string;
  birth_date: string | null; // YYYY-MM-DD
};

export type MonthBucket = {
  ym: string;             // YYYY-MM
  count: number;          // 参加人数 (participant × event)
  male: number;
  female: number;
  other: number;
  under6: number;         // 6 歳以下
  age7to9: number;        // 7〜9 歳
  over10: number;         // 10 歳以上
  firstA: number;         // 初回 (a 厳格)
  repeatA: number;        // リピート (a 厳格)
  firstB: number;         // 初回 (b 広め)
  repeatB: number;        // リピート (b 広め)
};

/**
 * 1 枚分の paid + attended 参加者行を全件取得 (ページネーション付)。
 * 期間フィルタ無しで全履歴を返す (呼び出し側で初回参加判定に使う)。
 */
export async function fetchAllPaidAttendedParticipations(
  supabase: SupabaseClient,
): Promise<ReportRow[]> {
  const PAGE = 1000;
  const out: ReportRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('reservations')
      .select(`
        id, paid_at, status,
        slots(date),
        reservation_participants(id, customer_id, gender_snapshot, birth_date_snapshot, attendance_status)
      `)
      .neq('status', 'cancelled')
      .not('paid_at', 'is', null)
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`reservation fetch failed: ${error.message}`);
    const rows = (data ?? []) as any[];
    for (const r of rows) {
      const date = (r.slots as any)?.date as string | undefined;
      if (!date) continue;
      const parts = (r.reservation_participants ?? []) as any[];
      for (const p of parts) {
        if (p.attendance_status === 'cancelled') continue;
        out.push({
          customer_id: p.customer_id ?? null,
          slot_date: date,
          gender: p.gender_snapshot,
          birth_date: p.birth_date_snapshot ?? null,
        });
      }
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100_000) break;
  }
  return out;
}

/** customers.pre_asms_* を customer_id キーで Map 化 */
export async function fetchPreAsmsMap(
  supabase: SupabaseClient,
  customerIds: string[],
): Promise<Map<string, { hadPreAsms: boolean }>> {
  const out = new Map<string, { hadPreAsms: boolean }>();
  if (customerIds.length === 0) return out;
  const PAGE = 500;
  for (let i = 0; i < customerIds.length; i += PAGE) {
    const chunk = customerIds.slice(i, i + PAGE);
    const { data, error } = await supabase
      .from('customers')
      .select('id, pre_asms_visit_count, pre_asms_first_visit_date')
      .in('id', chunk);
    if (error) throw new Error(`customers fetch failed: ${error.message}`);
    for (const c of (data ?? []) as any[]) {
      const had = (c.pre_asms_visit_count ?? 0) > 0 || !!c.pre_asms_first_visit_date;
      out.set(c.id as string, { hadPreAsms: had });
    }
  }
  return out;
}

/** birth_date と onDate (YYYY-MM-DD) から満年齢を計算 */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map((n) => parseInt(n, 10));
  const [oy, om, od] = onDate.split('-').map((n) => parseInt(n, 10));
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age--;
  return Math.max(0, age);
}

/**
 * 月別 bucket に集計する。
 * - allRows: 全履歴の参加者行 (期間フィルタ無し)
 * - fromYm/toYm: 集計対象期間 (YYYY-MM、両端含む)
 * - preAsmsMap: customer_id → { hadPreAsms }
 */
export function aggregate(
  allRows: ReportRow[],
  fromYm: string,
  toYm: string,
  preAsmsMap: Map<string, { hadPreAsms: boolean }>,
): { months: string[]; buckets: Map<string, MonthBucket>; total: MonthBucket } {
  // 月リスト展開
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
  const inRange = new Set(months);

  // 各 customer_id の「初回 ASMS 参加日」を全履歴から抽出 (slots.date の最小値)
  const firstDateByCustomer = new Map<string, string>();
  for (const r of allRows) {
    if (!r.customer_id) continue;
    const prev = firstDateByCustomer.get(r.customer_id);
    if (!prev || r.slot_date < prev) firstDateByCustomer.set(r.customer_id, r.slot_date);
  }

  function newBucket(ym: string): MonthBucket {
    return {
      ym, count: 0, male: 0, female: 0, other: 0,
      under6: 0, age7to9: 0, over10: 0,
      firstA: 0, repeatA: 0, firstB: 0, repeatB: 0,
    };
  }
  const buckets = new Map<string, MonthBucket>();
  for (const ym of months) buckets.set(ym, newBucket(ym));
  const total = newBucket('total');

  for (const r of allRows) {
    const ym = r.slot_date.slice(0, 7);
    if (!inRange.has(ym)) continue;
    const b = buckets.get(ym)!;

    const accumulate = (target: MonthBucket) => {
      target.count += 1;
      if (r.gender === 'male') target.male += 1;
      else if (r.gender === 'female') target.female += 1;
      else target.other += 1;

      if (r.birth_date && /^\d{4}-\d{2}-\d{2}$/.test(r.birth_date)) {
        const age = ageOn(r.birth_date, r.slot_date);
        if (age <= 6) target.under6 += 1;
        else if (age <= 9) target.age7to9 += 1;
        else target.over10 += 1;
      }

      // リピート判定 (a) 厳格
      let isRepeatA = false;
      if (r.customer_id) {
        const firstDate = firstDateByCustomer.get(r.customer_id);
        if (firstDate && firstDate < r.slot_date) isRepeatA = true;
      }
      if (isRepeatA) target.repeatA += 1; else target.firstA += 1;

      // リピート判定 (b) 広め: 厳格 OR 旧 Air レジ時代の来店歴あり
      let isRepeatB = isRepeatA;
      if (!isRepeatB && r.customer_id) {
        const pre = preAsmsMap.get(r.customer_id);
        if (pre?.hadPreAsms) isRepeatB = true;
      }
      if (isRepeatB) target.repeatB += 1; else target.firstB += 1;
    };
    accumulate(b);
    accumulate(total);
  }

  return { months, buckets, total };
}

/** 月別 bucket から CSV を組み立て (UTF-8 BOM 付き) */
export function buildCsv(
  months: string[],
  buckets: Map<string, MonthBucket>,
  total: MonthBucket,
): string {
  const header = [
    '月', '参加人数', '男', '女', 'その他',
    '6歳以下', '7-9歳', '10歳以上',
    '初回', 'リピート',
  ].join(',');
  const lines = [header];
  const writeRow = (b: MonthBucket, label: string) => {
    lines.push([
      label, b.count, b.male, b.female, b.other,
      b.under6, b.age7to9, b.over10,
      b.firstB, b.repeatB,  // CSV は (b) 広めを採用 (報告書向け)
    ].join(','));
  };
  for (const ym of months) writeRow(buckets.get(ym)!, ym);
  writeRow(total, '合計');
  return '﻿' + lines.join('\n') + '\n';
}

/** 会計年度 (4-3 月) を期間 YYYY-MM 文字列に展開 */
export function fiscalYearRange(year: number): { fromYm: string; toYm: string; label: string } {
  return {
    fromYm: `${year}-04`,
    toYm: `${year + 1}-03`,
    label: `${year}年度 (${year}-04 〜 ${year + 1}-03)`,
  };
}
