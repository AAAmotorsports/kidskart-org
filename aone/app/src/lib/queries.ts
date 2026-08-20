// ページ (Astro サーバ側) から使うデータ取得。
//
// 公開ページは anon クライアント + SECURITY DEFINER 関数で「集計だけ」読む。
// 管理ページは service_role で台帳そのものを読む。
//
// Supabase 未設定 (env が空) でもページを落とさない: null を返して
// 画面側に「準備中」を出させる。

import { getSupabase, getSupabaseAdmin } from './supabase';

export interface DayState {
  date: string;
  dow: number;
  is_holiday: boolean;
  is_past: boolean;
  is_today: boolean;
  weather: { status: string; message: string | null; staff_note: string | null };
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

export async function dayState(env: Env, date: string): Promise<DayState | null> {
  try {
    const { data, error } = await getSupabase(env).rpc('aone_day_state', { p_date: date });
    if (error) {
      console.warn('[queries] aone_day_state 失敗', error.message);
      return null;
    }
    return data as DayState;
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return null;
  }
}

export interface MonthDay {
  date: string;
  dow: number;
  is_holiday: boolean;
  weather: string;
  sport_am: string;
  sport_pm: string;
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
    return data as MonthDay[];
  } catch (e) {
    console.warn('[queries] Supabase 未設定?', e);
    return null;
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
  is_paid: boolean;
  forced: boolean;
  forced_reason: string | null;
  access_token: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
}

export const RESERVATION_COLUMNS =
  'id,reservation_number,kind,status,date,session,start_time,end_time,category_code,' +
  'party_size,vehicle_count,customer_id,contact_name,contact_kana,contact_phone,contact_email,' +
  'preferred_contact,source,request_note,staff_memo,tags,amount,is_paid,forced,forced_reason,' +
  'access_token,cancelled_at,cancel_reason,created_at';

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
