import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin } from '@lib/supabase';
import { notConfigured } from '@lib/api';
import { reservationsCsv, customersCsv, type CsvFile } from '@lib/csv';

export const prerender = false;

// GET /api/admin/export?type=reservations|customers[&from=&to=]
//
// 予約台帳と顧客名簿を CSV で落とす (Basic 認証は middleware で担保)。
// 月次の自動バックアップは /api/cron/backup が同じ関数でメール添付にしている。
function csvResponse(file: CsvFile): Response {
  return new Response(file.body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      // ファイル名に日本語を使うので filename* (RFC 5987) でも渡す
      'Content-Disposition':
        `attachment; filename="${file.filename.replace(/[^\x20-\x7e]/g, '_')}"; ` +
        `filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}

export const GET: APIRoute = async ({ url, locals }) => {
  const env = envFrom(locals);
  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  const supabase = getSupabaseAdmin(env);
  try {
    if (url.searchParams.get('type') === 'customers') {
      return csvResponse(await customersCsv(supabase));
    }
    return csvResponse(await reservationsCsv(supabase, {
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    }));
  } catch (e: any) {
    return new Response(String(e?.message ?? e), { status: 500 });
  }
};
