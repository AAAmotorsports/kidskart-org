// A-ONE 予約システムの共通型・ラベル・整形。
//
// ★ 受付可否の判定ロジックはここには置かない。
//   ルールは DB 関数 (aone_check_availability / aone_day_state) が唯一の正。
//   ここにあるのは「DB が返した結果をどう見せるか」だけ。

export type ReservationKind = 'sport' | 'rp' | 'charter' | 'night';
export type Session = 'am' | 'pm';
export type CategoryStatus = 'open' | 'limited' | 'closed' | 'off';

export const KIND_LABELS: Record<ReservationKind, string> = {
  sport: 'スポーツ走行',
  rp: 'レースパック (RP)',
  charter: '貸切',
  night: 'ナイター',
};

export const KIND_SHORT: Record<ReservationKind, string> = {
  sport: '走行',
  rp: 'RP',
  charter: '貸切',
  night: 'ナイター',
};

export const STATUS_LABELS: Record<string, string> = {
  confirmed: '確定',
  contact_wait: '連絡待ち',
  checking: '確認中',
  completed: '完了',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
};

export const CONTACT_METHOD_LABELS: Record<string, string> = {
  phone: '電話',
  email: 'メール',
  line: 'LINE',
  counter: '店頭',
  other: 'その他',
};

export const SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  phone: '電話',
  counter: '店頭',
  admin: '管理',
};

export const WEATHER_LABELS: Record<string, string> = {
  normal: '通常営業',
  rain_caution: '雨天注意',
  checking: '営業確認中',
  surface_recovery: '路面回復待ち',
  cancelled: '雨天中止',
  other: 'その他',
};

export const WEATHER_EMOJI: Record<string, string> = {
  normal: '🏁',
  rain_caution: '🌦',
  checking: '❓',
  surface_recovery: '💧',
  cancelled: '🚫',
  other: '📢',
};

export const BLOCK_KIND_LABELS: Record<string, string> = {
  race: 'レース',
  event: 'イベント',
  kids_event: 'キッズイベント',
  charter: '貸切',
  maintenance: 'メンテナンス',
  closed: '臨時休業',
  other: 'その他',
};

/**
 * 予定 (レース・イベント・臨時休業など) の表示名。
 *
 * 種別ラベルを頭に付けると「臨時休業 休業日」のように二重になるため、
 * 付けた名前をそのまま出す。名前が無いときだけ種別ラベルで補う。
 */
export function blockLabel(kind: string, label?: string | null): string {
  const t = (label ?? '').trim();
  return t || BLOCK_KIND_LABELS[kind] || kind;
}

export const BLOCK_SCOPE_LABELS: Record<string, string> = {
  all: '終日すべて停止',
  am: '午前のみ停止',
  pm: '午後のみ停止',
  time: '指定時間のみ停止',
  sport: 'スポーツ走行のみ停止',
  rp: 'RP のみ停止',
  category: '特定カテゴリーのみ停止',
};

/** ○ △ ✕ — の記号 (「今日走れる？」表示 — 仕様 7) */
export const STATUS_MARK: Record<CategoryStatus, string> = {
  open: '○',
  limited: '△',
  closed: '✕',
  off: '—',
};

export const STATUS_TEXT: Record<CategoryStatus, string> = {
  open: '走れます',
  limited: '残りわずか',
  closed: '受付停止',
  off: '対象外',
};

/**
 * カテゴリー 1 つの状態を利用者向けの一言にする。
 *
 * A-ONE の運用: カート・ミニバイクは予約なしの飛び込みでも走れるが、
 * キッズカートとその他 (大型バイク等) は事前予約が必要 (仕様外の実運用ルール)。
 * 「走れます」と出したせいでキッズの子が来て走れない、という事故を防ぐため、
 * 予約が要るカテゴリーは必ず「要予約」と出す。
 *
 * なお 'limited' (△ 残りわずか) はスポーツ走行では使わない (2026-08 オーナー指示)。
 * DB 側 (0007) が open / closed / off しか返さないので、この分岐は保険。
 */
export function categoryText(c: {
  status: CategoryStatus;
  requires_reservation?: boolean;
  walk_in_ok?: boolean;
  running?: boolean;
}): string {
  if (c.status === 'off') return '対象外';
  if (c.status === 'closed') return '受付停止';
  if (c.walk_in_ok) return c.status === 'limited' ? '走れます (残りわずか)' : '走れます';
  return c.status === 'limited' ? '要予約 (残りわずか)' : '要予約';
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];

/**
 * 「クオ様」「田中さん」のように敬称込みで登録された名前から敬称を落とす。
 * 表示時に「様」を足すので、そのままだと「クオ様 様」になってしまう。
 * (DB 側にも同じ処理の aone_strip_honorific がある — 公開名の生成用)
 */
export function stripHonorific(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/(様|さま|サマ|さん|サン|御中)\s*$/, '').trim();
}

/** 表示用の「○○ 様」。敬称が二重にならないようにする */
export function nameWithHonorific(name: string | null | undefined): string {
  const base = stripHonorific(name);
  return base ? `${base} 様` : '';
}

export function jaDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}年${m}月${d}日 (${WD[dowOf(iso)]})`;
}

/** 2026-08-26T06:21:50Z → 8/26 15:21 (JST)。管理画面の対応履歴などに使う */
export function jaDateTime(iso: string): string {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
  return p;
}

export function jaDateShort(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)} (${WD[dowOf(iso)]})`;
}

/** ISO 日付 (YYYY-MM-DD) の曜日番号。タイムゾーンに依存しない計算。 */
export function dowOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayJa(iso: string): string {
  return WD[dowOf(iso)];
}

/** JST の「今日」を YYYY-MM-DD で返す (Worker は UTC で動くため必須) */
export function todayJst(): string {
  return isoInJst(new Date());
}

export function isoInJst(d: Date): string {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/** YYYY-MM-DD に日数を足す */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function hhmm(t: string | null | undefined): string {
  return t ? t.slice(0, 5) : '';
}

export function yen(n: number | null | undefined): string {
  return n == null ? '—' : `¥${n.toLocaleString('ja-JP')}`;
}

/** 予約 1 件の時間帯を人が読める形にする */
export function timeRangeLabel(r: {
  kind: string;
  session?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}): string {
  if (r.kind === 'sport') {
    return r.session === 'am' ? 'AM (9:00〜12:00)' : 'PM (13:00〜16:30)';
  }
  const s = hhmm(r.start_time);
  const e = hhmm(r.end_time);
  return e ? `${s}〜${e}` : s;
}
