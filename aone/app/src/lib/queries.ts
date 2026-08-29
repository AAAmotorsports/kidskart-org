// ページ (Astro サーバ側) から使うデータ取得。
//
// 公開ページは anon クライアント + SECURITY DEFINER 関数で「集計だけ」読む。
// 管理ページは service_role で台帳そのものを読む。
//
// Supabase 未設定 (env が空) でもページを落とさない: null を返して
// 画面側に「準備中」を出させる。

import { getSupabase, getSupabaseAdmin } from './supabase';
import { todayJst } from './domain';

export interface DayState {
  date: string;
  dow: number;
  is_holiday: boolean;
  is_past: boolean;
  is_today: boolean;
  /** 営業状況 (受付可否に影響する)。source='block' = 臨時休業の予定から自動 */
  business: {
    status: string;
    source: 'manual' | 'block';
    message: string | null;
    staff_note: string | null;
  };
  /** 路面状況 (表示のみ)。未設定なら status は null */
  surface: { status: string | null };
  hours: { course_open: string; course_close: string };
  blocks: Array<{
    id: string; title: string; kind: string; scope: string;
    category_code: string | null; start_time: string | null; end_time: string | null;
    is_public: boolean; public_label: string; memo: string | null;
  }>;
  sport: Record<'am' | 'pm', {
    start_time: string; end_time: string;
    max_classes: number; used_classes: number; rp_groups: number; accepting: boolean;
    categories: Array<{
      code: string; name: string; short_name: string;
      status: 'open' | 'limited' | 'closed' | 'off';
      running: boolean;
      /** 事前予約が必要なカテゴリーか (false = 飛び込みでも走れる) */
      requires_reservation: boolean;
      /** 顧客向け予約フォームに出さないカテゴリーか */
      admin_only: boolean;
      /** 予約なしで来場してそのまま走れるか */
      walk_in_ok: boolean;
      reason: string; message: string;
    }>;
  }>;
  rp: {
    min_party: number; last_start: string; duration_minutes: number;
    slots: Array<{
      time: string; groups: number; max_groups: number;
      accepting: boolean; status: string | null; reason: string; message: string;
    }>;
  };
  charter: { reservations_today: number; confirmed_charter: boolean; accepting: boolean };
  counts: { sport: number; rp: number; charter: number; night: number; people: number };
}

/**
 * 営業状況・路面状況の欠けを既定値で埋める。
 *
 * DB マイグレーション (0021) を当てる前の関数は business / surface を返さない。
 * 先にアプリだけがデプロイされる瞬間があるので、そこで画面が落ちないようにする。
 * 既定は「営業中・路面は未設定」— 0021 以前の通常営業と同じ意味になる。
 */
function withStatus(state: any): DayState {
  return {
    ...state,
    business: state?.business ?? { status: 'open', source: 'manual', message: null, staff_note: null },
    surface: state?.surface ?? { status: null },
  } as DayState;
}

export async function dayState(env: Env, date: string): Promise<DayState | null> {
  try {
    const { data, error } = await getSupabase(env).rpc('aone_day_state', { p_date: date });
    if (error) {
      console.warn('[queries] aone_day_state 失敗', error.message);
      return null;
    }
    return data ? withStatus(data) : null;
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return null;
  }
}

export interface MonthCategory {
  code: string;
  name: string;
  short_name: string;
  status: 'open' | 'limited' | 'closed' | 'off';
  running: boolean;
  requires_reservation: boolean;
  walk_in_ok: boolean;
}

export interface MonthDay {
  date: string;
  dow: number;
  is_holiday: boolean;
  business: string;
  surface: string | null;
  sport_am: string;
  sport_pm: string;
  am_categories: MonthCategory[];
  pm_categories: MonthCategory[];
  rp_free: number;
  blocks: Array<{ title: string; public_label: string; kind: string; is_public: boolean }>;
  counts: { sport: number; rp: number; charter: number; night: number; people: number };
}

export async function monthState(env: Env, year: number, month: number): Promise<MonthDay[] | null> {
  try {
    const { data, error } = await getSupabase(env).rpc('aone_month_state', {
      p_year: year, p_month: month,
    });
    if (error) {
      console.warn('[queries] aone_month_state 失敗', error.message);
      return null;
    }
    // 0021 以前の関数は business / surface を返さない (上の withStatus と同じ理由)
    return (data as any[] ?? []).map((d) => ({
      ...d, business: d.business ?? 'open', surface: d.surface ?? null,
    })) as MonthDay[];
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return null;
  }
}

export interface RentalBooking {
  kind: 'rp' | 'charter';
  time: string;
  end_time: string | null;
  party_size: number;
  /** 公開用の表示名。設定が hidden のときは null */
  name: string | null;
}

/**
 * 公開カレンダー用の RP・貸切の予約 (時間・人数・表示名のみ)。
 * 日付をキーにしたオブジェクトで返る。名前の粒度は /admin/settings の設定次第。
 */
export async function rentalBookings(
  env: Env, from: string, to: string,
): Promise<Record<string, RentalBooking[]>> {
  try {
    const { data, error } = await getSupabase(env).rpc('aone_rental_bookings', {
      p_from: from, p_to: to,
    });
    if (error) {
      console.warn('[queries] aone_rental_bookings 失敗', error.message);
      return {};
    }
    return (data ?? {}) as Record<string, RentalBooking[]>;
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return {};
  }
}

export interface Category {
  code: string;
  name: string;
  short_name: string | null;
  sort_order: number;
  is_active: boolean;
  /** true = 事前予約が必要 / false = 飛び込みでも走れる */
  requires_reservation: boolean;
  /** true = 顧客向け予約フォームに出さない (管理画面からの代理入力のみ) */
  admin_only: boolean;
  /** 管理カレンダーでの表示色 */
  color: string;
}

export async function categories(env: Env): Promise<Category[]> {
  try {
    const { data } = await getSupabase(env)
      .from('aone_categories').select('*').eq('is_active', true).order('sort_order');
    return (data ?? []) as Category[];
  } catch {
    return [];
  }
}

export async function settings(env: Env): Promise<Record<string, any> | null> {
  try {
    const { data } = await getSupabase(env).from('aone_settings').select('*').eq('id', 1).single();
    return data ?? null;
  } catch {
    return null;
  }
}

// ---- 管理画面用 (service_role) ----------------------------------------------


/** 予約 1 件 (RESERVATION_COLUMNS で SELECT した形) */
export interface Reservation {
  id: string;
  reservation_number: string;
  kind: string;
  status: string;
  date: string;
  session: string | null;
  start_time: string | null;
  end_time: string | null;
  category_code: string | null;
  /** ナイターの内訳 (rp / charter)。ナイター以外は null */
  night_kind: string | null;
  /** 貸切の種別 (with_karts / course_only)。貸切以外は null */
  charter_type: string | null;
  party_size: number;
  vehicle_count: number | null;
  customer_id: string | null;
  contact_name: string;
  contact_kana: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  preferred_contact: string | null;
  source: string;
  request_note: string | null;
  staff_memo: string | null;
  tags: string[];
  amount: number | null;
  /** 金額を手で入力したか。true の間は人数・台数を変えても自動計算で上書きしない */
  amount_manual: boolean;
  is_paid: boolean;
  forced: boolean;
  forced_reason: string | null;
  access_token: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  /** 折り返し対応をした日時。null = まだ折り返していない */
  contacted_at: string | null;
  contacted_by: string | null;
  contact_method: string | null;
  contact_result: string | null;
  created_at: string;
}

export const RESERVATION_COLUMNS =
  'id,reservation_number,kind,status,date,session,start_time,end_time,category_code,' +
  'night_kind,charter_type,party_size,vehicle_count,customer_id,contact_name,contact_kana,contact_phone,contact_email,' +
  'preferred_contact,source,request_note,staff_memo,tags,amount,is_paid,forced,forced_reason,' +
  'access_token,cancelled_at,cancel_reason,contacted_at,contacted_by,contact_method,contact_result,' +
  'amount_manual,created_at';

export async function reservationsOfDay(env: Env, date: string) {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('date', date)
      .order('kind')
      .order('start_time', { nullsFirst: true });
    if (error) throw error;
    return (data ?? []) as unknown as Reservation[];
  } catch (e) {
    console.warn('[queries] reservationsOfDay 失敗', e);
    return [];
  }
}

/** 折り返し待ちのまま放置されている予約 (連絡待ち / 確認中 かつ 未対応) */
export interface PendingCallback {
  id: string;
  reservation_number: string;
  kind: string;
  status: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  party_size: number;
  contact_name: string;
  contact_phone: string | null;
  contact_email: string | null;
  request_note: string | null;
  created_at: string;
  hours_waiting: number;
}

/**
 * p_hours 時間以上たっても折り返していない予約を古い順に返す。
 * 管理画面の警告と、毎朝の cron メールの両方がこれを使う。
 */
export async function pendingCallbacks(env: Env, hours = 24) {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .rpc('aone_pending_callbacks', { p_hours: hours });
    if (error) throw error;
    return (data ?? []) as unknown as PendingCallback[];
  } catch (e) {
    console.warn('[queries] pendingCallbacks 失敗', e);
    return [];
  }
}

export async function reservationByToken(env: Env, token: string) {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('access_token', token)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as unknown as Reservation | null;
  } catch (e) {
    console.warn('[queries] reservationByToken 失敗', e);
    return null;
  }
}

export async function reservationById(env: Env, id: string) {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as unknown as Reservation | null;
  } catch (e) {
    console.warn('[queries] reservationById 失敗', e);
    return null;
  }
}

/**
 * 1 か月ぶんの予約 (管理カレンダーに予約名を出すため)。
 * キャンセル・無断キャンセルは除く。日付順・時間順で返す。
 */
export async function reservationsOfMonth(env: Env, year: number, month: number) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .gte('date', first)
      .lte('date', last)
      .in('status', ['confirmed', 'contact_wait', 'checking', 'completed'])
      .order('date')
      .order('session', { nullsFirst: true })
      .order('start_time', { nullsFirst: true });
    if (error) throw error;
    return (data ?? []) as unknown as Reservation[];
  } catch (e) {
    console.warn('[queries] reservationsOfMonth 失敗', e);
    return [] as Reservation[];
  }
}

/** 要対応 (連絡待ち・確認中) の予約 — 管理トップに出す */
export async function pendingReservations(env: Env, fromDate: string) {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .in('status', ['contact_wait', 'checking'])
      .gte('date', fromDate)
      .order('date')
      .limit(50);
    if (error) throw error;
    return (data ?? []) as unknown as Reservation[];
  } catch (e) {
    console.warn('[queries] pendingReservations 失敗', e);
    return [];
  }
}

export interface ReservationFilter {
  from?: string;
  to?: string;
  kind?: string;
  status?: string;
  q?: string;
  limit?: number;
}

/** 予約台帳の検索 (管理画面) */
export async function searchReservations(env: Env, f: ReservationFilter) {
  try {
    let query = getSupabaseAdmin(env)
      .from('aone_reservations')
      .select(RESERVATION_COLUMNS)
      .order('date', { ascending: false })
      .order('start_time', { nullsFirst: true })
      .limit(f.limit ?? 200);

    if (f.from) query = query.gte('date', f.from);
    if (f.to) query = query.lte('date', f.to);
    if (f.kind) query = query.eq('kind', f.kind);
    if (f.status) query = query.eq('status', f.status);
    if (f.q) {
      const like = `%${f.q}%`;
      query = query.or(
        `contact_name.ilike.${like},contact_kana.ilike.${like},contact_phone.ilike.${like},` +
        `contact_email.ilike.${like},reservation_number.ilike.${like}`,
      );
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as unknown as Reservation[];
  } catch (e) {
    console.warn('[queries] searchReservations 失敗', e);
    return [];
  }
}

export interface CustomerStat {
  id: string; name: string; kana: string | null; phone: string | null; email: string | null;
  tags: string[]; staff_memo: string | null; created_at: string;
  rp_count: number; sport_count: number; charter_count: number; night_count: number;
  cancel_count: number; no_show_count: number;
  last_visit_date: string | null; first_reservation_date: string | null;
}

/** 顧客一覧 (仕様 16) */
export async function customerStats(env: Env, q?: string, limit = 100): Promise<CustomerStat[]> {
  try {
    let query = getSupabaseAdmin(env)
      .from('aone_customer_stats')
      .select('*')
      .order('last_visit_date', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (q) {
      const like = `%${q}%`;
      query = query.or(`name.ilike.${like},kana.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as CustomerStat[];
  } catch (e) {
    console.warn('[queries] customerStats 失敗', e);
    return [];
  }
}

export async function customerDetail(env: Env, id: string) {
  try {
    const admin = getSupabaseAdmin(env);
    const [{ data: stat }, { data: rows }] = await Promise.all([
      admin.from('aone_customer_stats').select('*').eq('id', id).maybeSingle(),
      admin.from('aone_reservations').select(RESERVATION_COLUMNS)
        .eq('customer_id', id).order('date', { ascending: false }).limit(100),
    ]);
    return {
      stat: (stat ?? null) as CustomerStat | null,
      reservations: (rows ?? []) as unknown as Reservation[],
    };
  } catch (e) {
    console.warn('[queries] customerDetail 失敗', e);
    return { stat: null, reservations: [] as Reservation[] };
  }
}

// -----------------------------------------------------------------------------
// イベントの参加申込 (エントリー)
// -----------------------------------------------------------------------------
// 走行の予約とは別台帳。RLS で anon からは一切読めないので、
// 公開側が使えるのは aone_open_events() (集計だけ返す) のみ。

/** 参加申込を受け付けているイベント (公開用。個人情報は含まない) */
export interface OpenEvent {
  id: string;
  date: string;
  title: string;
  kind: string;
  entry_type: 'endurance' | 'sprint' | 'series';
  price: number | null;
  unit: 'team' | 'person';
  deadline: string;
  rules_url: string | null;
  vehicle_rules_url: string | null;
  classes: string[];
  note: string | null;
  entries: number;
}

export async function openEvents(env: Env): Promise<OpenEvent[]> {
  try {
    const { data, error } = await getSupabase(env).rpc('aone_open_events');
    if (error) {
      console.warn('[queries] aone_open_events 失敗', error.message);
      return [];
    }
    return (data ?? []) as OpenEvent[];
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return [];
  }
}

/**
 * その日の予定 (受付停止) を丸ごと読む。
 *
 * `aone_day_state()` の blocks は表示用に絞ってあり、`allow_categories` や
 * 参加申込の設定が入っていない。管理画面で予定を **編集** するには元の行が要る
 * ので、ここだけテーブルを直接読む (公開 API からは呼ばないこと)。
 */
export async function blocksOfDay(env: Env, date: string): Promise<any[]> {
  try {
    const { data, error } = await getSupabaseAdmin(env)
      .from('aone_blocks').select('*').eq('date', date)
      .order('start_time', { ascending: true, nullsFirst: true }).order('title');
    if (error) {
      console.warn('[queries] aone_blocks 失敗', error.message);
      return [];
    }
    return data ?? [];
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return [];
  }
}

export interface CronHealth {
  last_run_at: string | null;
  last_hour_jst: number | null;
  last_ok: boolean | null;
  last_tasks: number | null;
  last_detail: any[] | null;
  /** 90 分以上動いていない = 止まっている疑い */
  stale: boolean;
  mails_today: number;
  mails_failed_today: number;
}

/**
 * cron が動いているかの 1 行サマリ (管理トップの「自動メール」欄)。
 *
 * 定時実行を Cloudflare の cron に移した理由が「黙って止まるのが怖い」なので、
 * 止まったことに管理画面で気づけるようにしておく。
 */
export async function cronHealth(env: Env): Promise<CronHealth | null> {
  try {
    const { data, error } = await getSupabaseAdmin(env).rpc('aone_cron_health');
    if (error) {
      // 0025 を当てる前でも管理画面は開けるようにする (欄が出ないだけ)
      console.warn('[queries] aone_cron_health 失敗', error.message);
      return null;
    }
    return (data ?? null) as CronHealth | null;
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return null;
  }
}

export const ENTRY_COLUMNS =
  'id,entry_number,block_id,date,event_title,entry_type,status,customer_id,' +
  'team_name,contact_name,contact_kana,contact_email,contact_phone,' +
  'frame_maker,number_wish,race_class,amount,is_paid,agreed_at,note,staff_memo,' +
  'access_token,source,created_at,cancelled_at,cancel_reason';

export interface EventEntry {
  id: string;
  entry_number: string;
  block_id: string | null;
  date: string;
  event_title: string;
  entry_type: 'endurance' | 'sprint' | 'series';
  status: 'received' | 'confirmed' | 'cancelled';
  customer_id: string | null;
  team_name: string | null;
  contact_name: string;
  contact_kana: string | null;
  contact_email: string;
  contact_phone: string;
  frame_maker: string | null;
  number_wish: string | null;
  race_class: string | null;
  amount: number | null;
  is_paid: boolean;
  agreed_at: string | null;
  note: string | null;
  staff_memo: string | null;
  access_token: string;
  source: string;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

/** 管理用。日付か開催イベントで絞る。どちらも無ければ今日以降を新しい順に */
export async function eventEntries(
  env: Env,
  opt: { date?: string; blockId?: string; limit?: number } = {},
): Promise<EventEntry[]> {
  try {
    let query = getSupabaseAdmin(env).from('aone_event_entries').select(ENTRY_COLUMNS);
    if (opt.date) query = query.eq('date', opt.date);
    else if (opt.blockId) query = query.eq('block_id', opt.blockId);
    else query = query.gte('date', todayJst());
    const { data, error } = await query
      .order('date', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(opt.limit ?? 500);
    if (error) throw error;
    return (data ?? []) as unknown as EventEntry[];
  } catch (e) {
    console.warn('[queries] eventEntries 失敗', e);
    return [];
  }
}
