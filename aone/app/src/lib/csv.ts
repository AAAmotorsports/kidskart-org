// 予約台帳と顧客名簿を CSV にする。
//
// 管理画面のボタン (/api/admin/export) と、月次バックアップメール
// (/api/cron/backup) の両方がここを呼ぶ。列の定義を 2 か所に書くと、
// ボタンで落とした CSV とメールで届く CSV が食い違うため。

import {
  KIND_LABELS, STATUS_LABELS, SOURCE_LABELS, CHARTER_TYPE_LABELS,
  CONTACT_METHOD_LABELS, ENTRY_TYPE_LABELS, ENTRY_STATUS_LABELS, hhmm, todayJst,
} from './domain';
import { RESERVATION_COLUMNS, type Reservation, type CustomerStat } from './queries';

export interface CsvFile { filename: string; body: string }

/** Excel が UTF-8 と判るように BOM を付ける (付けないと日本語が化ける) */
const BOM = '\ufeff';

/** CSV の 1 セル。区切り・引用符・改行を含む値だけを囲む */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return BOM + [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

const RESERVATION_HEADER = [
  '予約番号', '種別', '貸切の種別', '状態', '日付', '時間帯', '開始', '終了',
  'カテゴリー', '人数', 'カート台数', '金額', '金額は手入力', '会計済',
  'お名前', 'ふりがな', '電話', 'メール', '受付経路',
  'ご要望', 'スタッフメモ', '強制受付', '強制の理由',
  '折り返し対応日時', '対応手段', '対応者', '対応メモ',
  'キャンセル日時', 'キャンセル理由', '受付日時',
];

function reservationRow(r: Reservation): unknown[] {
  return [
    r.reservation_number,
    KIND_LABELS[r.kind as keyof typeof KIND_LABELS] ?? r.kind,
    r.charter_type ? CHARTER_TYPE_LABELS[r.charter_type] ?? r.charter_type : '',
    STATUS_LABELS[r.status] ?? r.status,
    r.date,
    r.session === 'am' ? 'AM' : r.session === 'pm' ? 'PM' : '',
    hhmm(r.start_time),
    hhmm(r.end_time),
    r.category_code ?? '',
    r.party_size,
    r.vehicle_count ?? '',
    r.amount ?? '',
    r.amount_manual ? 'はい' : '',
    r.is_paid ? 'はい' : '',
    r.contact_name,
    r.contact_kana ?? '',
    r.contact_phone ?? '',
    r.contact_email ?? '',
    SOURCE_LABELS[r.source] ?? r.source,
    r.request_note ?? '',
    r.staff_memo ?? '',
    r.forced ? 'はい' : '',
    r.forced_reason ?? '',
    r.contacted_at ?? '',
    r.contact_method ? CONTACT_METHOD_LABELS[r.contact_method] ?? r.contact_method : '',
    r.contacted_by ?? '',
    r.contact_result ?? '',
    r.cancelled_at ?? '',
    r.cancel_reason ?? '',
    r.created_at,
  ];
}

const CUSTOMER_HEADER = [
  'お名前', 'ふりがな', '電話', 'メール',
  'レースパック', 'スポーツ走行', '貸切', 'ナイター',
  'キャンセル', '無断キャンセル', '初回予約日', '最終来場日', 'タグ', 'スタッフメモ',
];

/** 予約台帳。期間を指定しなければ全件 (バックアップ用途) */
export async function reservationsCsv(
  supabase: any,
  span?: { from?: string | null; to?: string | null },
): Promise<CsvFile> {
  let query = supabase
    .from('aone_reservations')
    .select(RESERVATION_COLUMNS)
    .order('date')
    .order('start_time', { nullsFirst: true });
  if (span?.from) query = query.gte('date', span.from);
  if (span?.to) query = query.lte('date', span.to);

  const { data, error } = await query;
  if (error) throw new Error('予約台帳を読み出せませんでした: ' + error.message);

  const rows = (data as unknown as Reservation[]).map(reservationRow);
  const label = span?.from || span?.to ? `_${span?.from ?? ''}-${span?.to ?? ''}` : '';
  return {
    filename: `A-ONE予約台帳${label}_${todayJst()}.csv`,
    body: toCsv(RESERVATION_HEADER, rows),
  };
}

export async function customersCsv(supabase: any): Promise<CsvFile> {
  const { data, error } = await supabase
    .from('aone_customer_stats')
    .select('*')
    .order('last_visit_date', { ascending: false, nullsFirst: false });
  if (error) throw new Error('顧客名簿を読み出せませんでした: ' + error.message);

  const rows = ((data ?? []) as unknown as CustomerStat[]).map((c) => [
    c.name, c.kana ?? '', c.phone ?? '', c.email ?? '',
    c.rp_count, c.sport_count, c.charter_count, c.night_count,
    c.cancel_count, c.no_show_count,
    c.first_reservation_date ?? '', c.last_visit_date ?? '',
    (c.tags ?? []).join(' / '), c.staff_memo ?? '',
  ]);
  return { filename: `A-ONE顧客名簿_${todayJst()}.csv`, body: toCsv(CUSTOMER_HEADER, rows) };
}

/** イベント参加申込 (エントリー) */
export const ENTRY_HEADER = [
  '申込番号', '開催日', 'イベント', '様式', '状態',
  'チーム名', '氏名', 'ふりがな', '電話', 'メール',
  '参加クラス', 'ゼッケン', 'フレームメーカー',
  '参加費', '入金', '規約同意', '連絡事項', 'スタッフメモ',
  '入力経路', '申込日時', '取消日時', '取消理由',
];

export async function entriesCsv(supabase: any): Promise<CsvFile> {
  const { data, error } = await supabase
    .from('aone_event_entries')
    .select('*')
    .order('date')
    .order('created_at');
  if (error) throw new Error('参加申込を読み出せませんでした: ' + error.message);

  const rows = ((data ?? []) as any[]).map((e) => [
    e.entry_number, e.date, e.event_title,
    ENTRY_TYPE_LABELS[e.entry_type] ?? e.entry_type,
    ENTRY_STATUS_LABELS[e.status] ?? e.status,
    e.team_name ?? '', e.contact_name, e.contact_kana ?? '',
    e.contact_phone, e.contact_email,
    e.race_class ?? '', e.number_wish ?? '', e.frame_maker ?? '',
    e.amount ?? '', e.is_paid ? '済' : '', e.agreed_at ? '済' : '',
    e.note ?? '', e.staff_memo ?? '',
    SOURCE_LABELS[e.source] ?? e.source, e.created_at ?? '',
    e.cancelled_at ?? '', e.cancel_reason ?? '',
  ]);
  return { filename: `A-ONE参加申込_${todayJst()}.csv`, body: toCsv(ENTRY_HEADER, rows) };
}
