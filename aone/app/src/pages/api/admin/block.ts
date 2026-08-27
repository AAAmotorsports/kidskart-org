import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { str, mapRpcError, notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/admin/block
// レース・イベント・メンテナンス・臨時休業などの受付停止予定 (仕様 14)。
// 一度ここに登録すれば、予約可否判定・「今日走れる？」・公開スケジュールの
// すべてに反映される (仕様 19: 同じ予定を二度入力しない)。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;
  const supabase = getSupabaseAdmin(env);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const action = str(body?.action) ?? 'create';

  if (action === 'delete') {
    const id = str(body?.id);
    if (!id) return json({ error: 'id が必要です' }, 400);
    const { error } = await supabase.from('aone_blocks').delete().eq('id', id);
    if (error) return mapRpcError(error);
    return json({ ok: true });
  }

  const dates: string[] = Array.isArray(body?.dates)
    ? body.dates.filter((d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [str(body?.date)].filter(Boolean) as string[];

  if (dates.length === 0) return json({ error: '日付を指定してください' }, 400);
  const title = str(body?.title);
  if (!title) return json({ error: '予定名を入力してください' }, 400);

  const scope = str(body?.scope) ?? 'all';

  // 参加申込の受付設定 (0022)。チェックが外れていれば全部 null に倒す。
  // 中途半端に残しておくと、あとで受付を開けたときに古い金額で出てしまう。
  const entryOpen = body?.entry_open === true;
  const ENTRY_TYPES = ['endurance', 'sprint', 'series'];
  const entryType = str(body?.entry_type);
  if (entryOpen && (!entryType || !ENTRY_TYPES.includes(entryType))) {
    return json({ error: '申込の様式が不正です' }, 400);
  }
  const priceRaw = str(body?.entry_price);
  const entryPrice = priceRaw && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;
  const classes = (str(body?.entry_classes) ?? '')
    .split(/[,、]/).map((c) => c.trim()).filter(Boolean);

  const entry = entryOpen ? {
    entry_open: true,
    entry_type: entryType,
    entry_price: entryPrice,
    entry_unit: str(body?.entry_unit) === 'team' ? 'team' : 'person',
    entry_deadline: str(body?.entry_deadline) ?? null,
    entry_classes: entryType === 'series' ? classes : [],
    entry_rules_url: str(body?.entry_rules_url) ?? null,
    entry_vehicle_rules_url: str(body?.entry_vehicle_rules_url) ?? null,
    entry_note: str(body?.entry_note) ?? null,
  } : {
    entry_open: false,
    entry_type: null,
    entry_price: null,
    entry_deadline: null,
    entry_classes: [],
    entry_rules_url: null,
    entry_vehicle_rules_url: null,
    entry_note: null,
  };

  const rows = dates.map((date) => ({
    date,
    kind: str(body?.kind) ?? 'event',
    title,
    scope,
    category_code: scope === 'category' ? str(body?.category_code) ?? null : null,
    // 「指定したカテゴリーだけ走れる」で許すカテゴリー。
    // 空のまま保存すると何も止まらない (登録し忘れで全部止まる事故を避ける)
    allow_categories: scope === 'only_category'
      ? (str(body?.allow_categories) ?? '').split(/[,、]/).map((c) => c.trim()).filter(Boolean)
      : [],
    start_time: str(body?.start_time) ?? null,
    end_time: str(body?.end_time) ?? null,
    blocks_sport: body?.blocks_sport !== false,
    blocks_rp: body?.blocks_rp !== false,
    blocks_charter: body?.blocks_charter !== false,
    is_public: body?.is_public !== false,
    public_label: str(body?.public_label) ?? null,
    memo: str(body?.memo) ?? null,
    created_by: str(body?.actor) ?? 'admin',
    ...entry,
  }));

  const { data, error } = await supabase.from('aone_blocks').insert(rows).select('id,date');
  if (error) return mapRpcError(error);
  return json({ ok: true, created: data?.length ?? 0, blocks: data });
};
