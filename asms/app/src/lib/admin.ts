// Small helpers shared across /admin/* server pages.
//
// * SYSTEM_ADMIN_UUID is the sentinel we stamp into audit-ish columns
//   (customer_progressions.changed_by, customer_bests.recorded_by) while
//   the admin panel still runs behind HTTP Basic Auth. Once Supabase Auth
//   lands and we have real per-staff UUIDs, migrate these rows and stop
//   using the sentinel.
export const SYSTEM_ADMIN_UUID = '00000000-0000-0000-0000-000000000001';

export const SKILL_LEVELS = [
  { code: 'first_time',            label: '初回',            emoji: '🌱' },
  { code: 'needs_re_lecture',      label: '再説明要',        emoji: '🔁' },
  { code: 'solo_ok',               label: '単独OK',          emoji: '✅' },
  { code: 'challenge_recommended', label: 'チャレンジ推奨',  emoji: '⭐' },
  { code: 'challenge_active',      label: 'チャレンジ参加',  emoji: '🏁' },
] as const;

export type SkillLevelCode = typeof SKILL_LEVELS[number]['code'];

export function skillLabel(code: string | null | undefined): string {
  const found = SKILL_LEVELS.find((s) => s.code === code);
  return found ? `${found.emoji} ${found.label}` : code ?? '';
}

export const ATTENDANCE_STATUSES = [
  { code: 'expected',  label: '予約中',   className: 'expected' },
  { code: 'attended',  label: '出席',     className: 'attended' },
  { code: 'no_show',   label: '無断欠席', className: 'noshow' },
  { code: 'cancelled', label: 'キャンセル', className: 'cancelled' },
] as const;

export function attendanceLabel(code: string | null | undefined): string {
  const found = ATTENDANCE_STATUSES.find((a) => a.code === code);
  return found?.label ?? code ?? '';
}

export function attendanceClass(code: string | null | undefined): string {
  const found = ATTENDANCE_STATUSES.find((a) => a.code === code);
  return found?.className ?? 'muted';
}

const weekdayJa = ['日', '月', '火', '水', '木', '金', '土'];
export function jaDateLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${weekdayJa[d.getDay()]})`;
}
export function jaDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()} (${weekdayJa[d.getDay()]})`;
}

export function ageOn(birthDate: string, onDate?: string): number {
  const b = new Date(birthDate + 'T00:00:00');
  const t = onDate ? new Date(onDate + 'T00:00:00') : new Date();
  let a = t.getFullYear() - b.getFullYear();
  const m = t.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--;
  return Math.max(0, a);
}

export const PAYMENT_METHODS = [
  { code: 'cash',   label: '現金',   emoji: '💴' },
  { code: 'paypay', label: 'PayPay', emoji: '📱' },
  { code: 'credit', label: 'クレカ', emoji: '💳' },
  { code: 'other',  label: 'その他', emoji: '📝' },
] as const;

export type PaymentMethodCode = typeof PAYMENT_METHODS[number]['code'];

export function paymentLabel(code: string | null | undefined): string {
  const found = PAYMENT_METHODS.find((p) => p.code === code);
  return found ? `${found.emoji} ${found.label}` : '未会計';
}

export function paymentShort(code: string | null | undefined): string {
  return PAYMENT_METHODS.find((p) => p.code === code)?.label ?? '—';
}

export function formatMs(ms: number): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const total = Math.max(0, ms);
  const mm = Math.floor(total / 60000);
  const ss = Math.floor((total % 60000) / 1000);
  const ff = total % 1000;
  return mm > 0
    ? `${mm}:${String(ss).padStart(2, '0')}.${String(ff).padStart(3, '0')}`
    : `${ss}.${String(ff).padStart(3, '0')}秒`;
}
