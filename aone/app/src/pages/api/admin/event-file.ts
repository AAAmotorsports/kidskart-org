import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { str, notConfigured } from '@lib/api';

export const prerender = false;

// アップロードできる大きさの上限。エントリーリストやタイムスケジュールの PDF は
// ふつう数百 KB。10 MB もあれば足りるし、これ以上は base64 にしたときに
// Workers のメモリと Supabase への送信で無理が出る。
const MAX_BYTES = 10 * 1024 * 1024;

const KINDS = ['entry_list', 'timetable', 'rules', 'vehicle_rules', 'result', 'other'];

// 既定の題名。スタッフが何も入れなくても、お客様に意味の分かる名前で出す
const DEFAULT_TITLES: Record<string, string> = {
  entry_list: 'エントリーリスト',
  timetable: 'タイムスケジュール',
  rules: '特別規則書',
  vehicle_rules: '車輌規則',
  result: 'リザルト',
  other: '資料',
};

function toBase64(bytes: Uint8Array): string {
  // btoa は文字列しか受け取らないので、いったん latin1 の文字列にする。
  // 一度に渡すとスタックが溢れるため小分けにする (PDF は数 MB になりうる)
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// POST /api/admin/event-file
//
// イベントの配布資料 (PDF) を預かる。
//   アップロード … multipart/form-data で file と block_id を送る
//   削除・公開切替 … JSON で { action: 'delete' | 'toggle', id }
//
// 中身は aone_event_files に base64 で入れる。ストレージを別に用意しないのは、
// 設定する場所と鍵を増やしたくないため (db/0028 に理由を書いてある)。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;
  const supabase = getSupabaseAdmin(env);

  const type = request.headers.get('content-type') ?? '';

  // ---- 削除・公開切替 (JSON) ----
  if (type.includes('application/json')) {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'リクエストの形式が不正です' }, 400);
    }
    const id = str(body?.id);
    if (!id) return json({ error: 'id が必要です' }, 400);

    if (body?.action === 'delete') {
      const { error } = await supabase.from('aone_event_files').delete().eq('id', id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (body?.action === 'toggle') {
      const { error } = await supabase.from('aone_event_files')
        .update({ is_public: body?.is_public === true }).eq('id', id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (body?.action === 'rename') {
      const title = str(body?.title);
      if (!title) return json({ error: '題名を入力してください' }, 400);
      const { error } = await supabase.from('aone_event_files')
        .update({ title }).eq('id', id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    return json({ error: '不明な操作です' }, 400);
  }

  // ---- アップロード (multipart/form-data) ----
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'ファイルを受け取れませんでした' }, 400);
  }

  const blockId = str(form.get('block_id'));
  if (!blockId) return json({ error: 'イベントを特定できませんでした' }, 400);

  const kind = str(form.get('kind')) ?? 'other';
  if (!KINDS.includes(kind)) return json({ error: '資料の種類が不正です' }, 400);

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: 'PDF を選んでください' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({
      error: `ファイルが大きすぎます (${(file.size / 1024 / 1024).toFixed(1)} MB)。`
        + `${MAX_BYTES / 1024 / 1024} MB までにしてください`,
    }, 400);
  }

  const name = file.name || 'document.pdf';
  // 中身で判定する。拡張子だけ見ると、別のファイルを PDF として配ってしまう
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (!isPdf) return json({ error: 'PDF ファイルではないようです' }, 400);

  const title = str(form.get('title')) ?? DEFAULT_TITLES[kind] ?? '資料';
  const sortRaw = str(form.get('sort_order'));
  const sortOrder = sortRaw && Number.isFinite(Number(sortRaw)) ? Number(sortRaw) : 0;

  const { data, error } = await supabase.from('aone_event_files').insert({
    block_id: blockId,
    kind,
    title,
    file_name: name,
    mime: 'application/pdf',
    size_bytes: bytes.length,
    data: toBase64(bytes),
    sort_order: sortOrder,
  }).select('id').maybeSingle();

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, id: (data as any)?.id, size_bytes: bytes.length }, 201);
};
