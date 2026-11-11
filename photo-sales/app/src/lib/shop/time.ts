const JST = 9 * 3600 * 1000;

/** 'YYYY-MM-DD' (JST) に n 日足した日の翌 0:00 JST を UTC の Date で返す */
export function endOfDayJst(shootDate: string, plusDays: number): Date {
  const [y, m, d] = shootDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + plusDays + 1) - JST);
}

/** 閲覧・販売の終了時刻 (撮影日 + view_days 日の翌 0:00 JST) */
export function viewEnd(shootDate: string, viewDays: number): Date {
  return endOfDayJst(shootDate, viewDays);
}

/** ダウンロード期限 = min(支払日 + purchased_days, 撮影日 + purchased_max_days の翌 0:00 JST) */
export function downloadExpiry(shootDate: string, paidAt: Date, paidDays: number, maxDays: number): Date {
  const a = paidAt.getTime() + paidDays * 86400_000;
  const b = endOfDayJst(shootDate, maxDays).getTime();
  return new Date(Math.min(a, b));
}
