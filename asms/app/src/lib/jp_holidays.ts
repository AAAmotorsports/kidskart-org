// Japanese national holidays lookup table (2025〜2028).
//
// 春分の日 / 秋分の日 are astronomical — the exact date is announced by
// 国立天文台 the preceding February — so this table needs a refresh each
// year to add the following year. The intent is: keep about three years
// visible from "today" so the admin never picks a month with missing
// holidays. When the current year rolls forward, drop the oldest entry
// and add the new one.

export type Holiday = { date: string; name: string };

const TABLE: Record<number, Array<[number, number, string]>> = {
  2025: [
    [1, 1, '元日'],
    [1, 13, '成人の日'],
    [2, 11, '建国記念の日'],
    [2, 23, '天皇誕生日'],
    [2, 24, '振替休日'],
    [3, 20, '春分の日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [5, 6, '振替休日'],
    [7, 21, '海の日'],
    [8, 11, '山の日'],
    [9, 15, '敬老の日'],
    [9, 23, '秋分の日'],
    [10, 13, 'スポーツの日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
    [11, 24, '振替休日'],
  ],
  2026: [
    [1, 1, '元日'],
    [1, 12, '成人の日'],
    [2, 11, '建国記念の日'],
    [2, 23, '天皇誕生日'],
    [3, 20, '春分の日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [5, 6, '振替休日'],
    [7, 20, '海の日'],
    [8, 11, '山の日'],
    [9, 21, '敬老の日'],
    [9, 22, '国民の休日'],
    [9, 23, '秋分の日'],
    [10, 12, 'スポーツの日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
  ],
  2027: [
    [1, 1, '元日'],
    [1, 11, '成人の日'],
    [2, 11, '建国記念の日'],
    [2, 23, '天皇誕生日'],
    [3, 21, '春分の日'],
    [3, 22, '振替休日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [7, 19, '海の日'],
    [8, 11, '山の日'],
    [9, 20, '敬老の日'],
    [9, 23, '秋分の日'],
    [10, 11, 'スポーツの日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
  ],
  2028: [
    [1, 1, '元日'],
    [1, 10, '成人の日'],
    [2, 11, '建国記念の日'],
    [2, 23, '天皇誕生日'],
    [3, 20, '春分の日'],
    [4, 29, '昭和の日'],
    [5, 3, '憲法記念日'],
    [5, 4, 'みどりの日'],
    [5, 5, 'こどもの日'],
    [7, 17, '海の日'],
    [8, 11, '山の日'],
    [9, 18, '敬老の日'],
    [9, 22, '秋分の日'],
    [10, 9, 'スポーツの日'],
    [11, 3, '文化の日'],
    [11, 23, '勤労感謝の日'],
  ],
};

export function getJapaneseHolidays(year: number, month: number): Holiday[] {
  const entries = TABLE[year];
  if (!entries) return [];
  return entries
    .filter(([m]) => m === month)
    .map(([m, d, name]) => ({
      date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      name,
    }));
}

export function hasHolidayTable(year: number): boolean {
  return year in TABLE;
}
