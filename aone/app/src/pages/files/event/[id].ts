import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';

export const prerender = false;

// GET /files/event/<id>
//
// イベントの配布資料 (PDF) を配る。表そのものは anon から読めないので、
// 公開してよいもの (is_public) だけをここで判断して返す。
// 非公開に切り替えたら、この URL を知っている人にも見えなくなる。
export const GET: APIRoute = async ({ params, locals }) => {
  const env = envFrom(locals);
  const id = params.id ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });

  const { data, error } = await getSupabaseAdmin(env)
    .from('aone_event_files')
    .select('file_name, mime, data, is_public, size_bytes')
    .eq('id', id)
    .maybeSingle();

  const row = data as any;
  if (error || !row || !row.is_public) return new Response('Not found', { status: 404 });

  const bin = atob(row.data as string);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  // ファイル名に日本語や記号が入るので RFC 5987 の書き方で渡す。
  // inline にしておくと、スマホでもその場で開ける (保存もできる)
  const name = encodeURIComponent(row.file_name || 'document.pdf');
  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime || 'application/pdf',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename*=UTF-8''${name}`,
      // 差し替えたら別の id になるので、長めに持たせてよい
      'Cache-Control': 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
