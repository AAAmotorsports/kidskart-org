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

export const CHARTER_TYPE_LABELS: Record<string, string> = {
  with_karts: 'レンタルカート付き',
  course_only: 'コースのみ',
};

export const SOURCE_LABELS: Record<string, string> = {
  web: 'Web',
  phone: '電話',
  counter: '店頭',
  admin: '管理',
};

/**
 * 営業状況 — 営業しているかどうか。受付可否に影響する。
 *
 * 既定は「営業中」。closed / cancelled の日は予約を受け付けない
 * (判定は aone_check_availability。ここにあるのはラベルだけ)。
 */
export const BUSINESS_LABELS: Record<string, string> = {
  open: '営業中',
  checking: '営業確認中',
  cancelled: '走行中止',
  closed: '休業',
};

export const BUSINESS_EMOJI: Record<string, string> = {
  open: '🏁',
  checking: '❓',
  cancelled: '🚫',
  closed: '🈳',
};

/** 表示順 (管理画面のボタンの並び) */
export const BUSINESS_ORDER = ['open', 'checking', 'cancelled', 'closed'] as const;

/**
 * 路面状況 — 営業状況とは別軸。**受付可否には一切影響しない**。
 * 未設定 (null) のときは何も表示しない (雨の日に「ドライ」と出したら嘘になる)。
 */
export const SURFACE_LABELS: Record<string, string> = {
  dry: 'ドライ',
  wet: 'ウェット',
  drying: 'ウェット→ドライ',
  heavy_wet: 'ヘビーウェット',
};

export const SURFACE_EMOJI: Record<string, string> = {
  dry: '☀️',
  wet: '💧',
  drying: '🌤',
  heavy_wet: '🌧',
};

export const SURFACE_ORDER = ['dry', 'wet', 'drying', 'heavy_wet'] as const;

/** 路面状況の表示文字列 (未設定なら null) */
export function surfaceText(status?: string | null): string | null {
  if (!status) return null;
  return `${SURFACE_EMOJI[status] ?? ''} 路面 ${SURFACE_LABELS[status] ?? status}`.trim();
}

/**
 * イベントの参加申込 (エントリー) の様式。
 *
 * 走行の予約とは別台帳 (aone_event_entries)。聞く項目が違ううえ、
 * 走行枠を消費しないため (イベント日は予定が終日止めている)。
 */
export const ENTRY_TYPE_LABELS: Record<string, string> = {
  sprint: 'スプリント (レンタルカート)',
  endurance: '耐久 (レンタルカート)',
  series: 'RMC (マイカート)',
};

/** 管理画面のプルダウンの並び。使う頻度の高い順 */
export const ENTRY_TYPE_ORDER = ['sprint', 'endurance', 'series'] as const;

/**
 * 参加クラスの選択肢。RMC (マイカート) だけで使う。
 * レンタルカートの耐久・スプリントにクラス分けは無い。
 */
export const RACE_CLASSES = ['Light', 'Junior', 'Mini', 'Micro', 'ビギナー', 'SS'] as const;

export const ENTRY_STATUS_LABELS: Record<string, string> = {
  received: '受付済み',
  confirmed: '参加確定',
  cancelled: '取り消し',
};

/** 申込者の呼び方。耐久はチーム代表、ほかは本人 */
export function entryPersonLabel(type: string): string {
  return type === 'endurance' ? '代表者' : '参加者';
}

/** 「20,000 円 / チーム」。金額未設定なら null (「お問い合わせ」表示にする) */
export function entryPriceLabel(price: number | null, unit: string): string | null {
  if (price == null) return null;
  return `${yen(price)} / ${unit === 'team' ? 'チーム' : '人'}`;
}

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
 * 種別ラベルを頭に付ける予定の種類。
 *
 * レース・イベントは「何のイベントか」が伝わる方がよいので付ける。
 * 臨時休業・メンテナンス・貸切は、付けた名前だけで意味が通るうえ、
 * 付けると「臨時休業 休業日」のように二重になるので付けない。
 */
const BLOCK_PREFIXED_KINDS = new Set(['race', 'event', 'kids_event']);

/** 予定 (レース・イベント・臨時休業など) の表示名 */
export function blockLabel(kind: string, label?: string | null): string {
  const name = (label ?? '').trim();
  const kindLabel = BLOCK_KIND_LABELS[kind] ?? kind;

  if (!name) return kindLabel;
  // 名前が種別を含んでいれば、付けても二重になるだけ
  if (!BLOCK_PREFIXED_KINDS.has(kind) || name.includes(kindLabel)) return name;
  return `${kindLabel} ${name}`;
}

export const BLOCK_SCOPE_LABELS: Record<string, string> = {
  all: '終日すべて停止',
  am: '午前のみ停止',
  pm: '午後のみ停止',
  time: '指定時間のみ停止',
  sport: 'スポーツ走行のみ停止',
  rp: 'RP のみ停止',
  category: '特定カテゴリーのみ停止',
  only_category: '指定したカテゴリーだけ走れる (ほかは停止)',
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

/** JST の「いま」の HH:MM */
export function nowHmJst(d: Date = new Date()): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
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

/**
 * 「今日走れる？」で、いま何を見せるべきか (2026-08 オーナー確認)。
 *
 *   〜 コースオープン (8:30)      … 準備中。「8:30 コースオープン」と出す
 *   コースオープン 〜 クローズ    … 営業中
 *   クローズ (17:30) 〜 切替 (18:00) … 本日は終了しました
 *   切替 (18:00) 〜 24:00         … **翌日**を出す (もう今日の情報は要らない)
 *
 * 切り替え時刻はコースクローズの 30 分後。営業時間を変えれば一緒に動く。
 * 日付をまたいだあとは自然に「当日の準備中」に戻る (0:00〜8:30)。
 *
 * ★ これは **表示だけ**。予約の受付可否には一切かかわらない
 *   (受付判定は SQL 側 = `aone_check_availability` が唯一の正)。
 */
export type OpenPhase = 'before_open' | 'open' | 'after_close';

export interface DayFocus {
  /** 画面の主役にする日 */
  date: string;
  /** 18 時を過ぎて翌日に切り替わっているか */
  is_tomorrow: boolean;
  phase: OpenPhase;
  /** 翌日に切り替わる時刻 (HH:MM) */
  switch_time: string;
}

export const PHASE_LABELS: Record<OpenPhase, string> = {
  before_open: '準備中',
  open: '営業中',
  after_close: '本日は終了',
};

export const PHASE_EMOJI: Record<OpenPhase, string> = {
  before_open: '🕗',
  open: '🏁',
  after_close: '🌙',
};

/** HH:MM に分を足す (24 時を超えたら 23:59 で止める) */
function addMinutesHm(hm: string, minutes: number): string {
  const [h, m] = hm.split(':').map(Number);
  const t = h * 60 + m + minutes;
  if (t >= 24 * 60) return '23:59';
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function dayFocus(
  hours: { course_open?: string | null; course_close?: string | null } | null | undefined,
  today: string = todayJst(),
  nowHm: string = nowHmJst(),
): DayFocus {
  const open = hhmm(hours?.course_open) || '08:30';
  const close = hhmm(hours?.course_close) || '17:30';
  const switchTime = addMinutesHm(close, 30);

  if (nowHm >= switchTime) {
    return { date: addDays(today, 1), is_tomorrow: true, phase: 'before_open', switch_time: switchTime };
  }
  const phase: OpenPhase = nowHm < open ? 'before_open' : nowHm < close ? 'open' : 'after_close';
  return { date: today, is_tomorrow: false, phase, switch_time: switchTime };
}

/**
 * 頭に出すバッジ。臨時休業・走行中止は営業状況が勝つ
 * (時間帯より「今日はやっていない」ほうが大事)。
 */
export function openBadge(business: string, phase: OpenPhase): {
  label: string; emoji: string; tone: 'ok' | 'soft' | 'warn' | 'ng';
} {
  if (business === 'cancelled' || business === 'closed') {
    return { label: BUSINESS_LABELS[business] ?? business, emoji: BUSINESS_EMOJI[business] ?? '🚫', tone: 'ng' };
  }
  if (business === 'checking') {
    return { label: BUSINESS_LABELS.checking, emoji: BUSINESS_EMOJI.checking, tone: 'warn' };
  }
  return {
    label: PHASE_LABELS[phase],
    emoji: PHASE_EMOJI[phase],
    tone: phase === 'open' ? 'ok' : 'soft',
  };
}

/** 「本日は 8:30 コースオープンです」の 1 行。営業していない日は出さない */
export function openNote(
  business: string, f: DayFocus, courseOpen?: string | null,
): string | null {
  if (business === 'cancelled' || business === 'closed') return null;
  if (f.phase !== 'before_open') return null;
  // 見出しなので「08:30」ではなく「8:30」と書く (サイトのほかの表記に合わせる)
  const t = (hhmm(courseOpen) || '08:30').replace(/^0/, '');
  return `${f.is_tomorrow ? '明日' : '本日'}は ${t} コースオープンです`;
}

/**
 * 月のプルダウンに出す選択肢。
 *
 * 「8 月に 12 月の予定を見たい」が実運用でよくあるのに、前月・翌月ボタンだけだと
 * 4 回押すことになる。過去は 3 か月、先は 12 か月まで出す
 * (レースの予定は年内ぶんまでしか立たない)。
 *
 * 今見ている月がこの範囲の外なら、それも足す。選ぶ手段が消えるのを防ぐため。
 */
export function monthOptions(
  currentYm: string,
  todayIso: string = todayJst(),
): { ym: string; label: string }[] {
  const thisYm = todayIso.slice(0, 7);
  const [ty, tm] = thisYm.split('-').map(Number);
  const list: string[] = [];
  for (let i = -3; i <= 12; i++) {
    const d = new Date(Date.UTC(ty, tm - 1 + i, 1));
    list.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  if (/^\d{4}-\d{2}$/.test(currentYm) && !list.includes(currentYm)) {
    list.push(currentYm);
    list.sort();
  }
  return list.map((ym) => {
    const [y, m] = ym.split('-').map(Number);
    return { ym, label: `${y}年${m}月${ym === thisYm ? ' (今月)' : ''}` };
  });
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
