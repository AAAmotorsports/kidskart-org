const JST = 9 * 3600 * 1000;
/** JST の今日 'YYYY-MM-DD' */
export function todayJst(now = new Date()): string {
  return new Date(now.getTime() + JST).toISOString().slice(0, 10);
}
/** JST の現在時刻 'HH:MM' */
export function nowHmJst(now = new Date()): string {
  return new Date(now.getTime() + JST).toISOString().slice(11, 16);
}
