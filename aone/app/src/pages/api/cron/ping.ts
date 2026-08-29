import type { APIRoute } from 'astro';
import { envFrom, getSupabaseAdmin, json } from '@lib/supabase';
import { notConfigured } from '@lib/api';

export const prerender = false;

// POST /api/cron/ping
//
// cron が 1 回動いたことを記録する (aone_cron_log)。Worker の scheduled が
// 毎時これを呼ぶ。**送るものが無い時間も呼ぶ** — 記録が途切れたことが
// 「止まった」の証拠になるので、動いた回はすべて残す。
//
// 記録するのは「いつ動いたか」だけ。1 通ごとの成否と失敗理由は
// これまでどおり aone_mail_log にある (2 か所に同じものを持たない)。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = envFrom(locals);

  if (!env.CRON_SECRET) return json({ error: 'CRON_SECRET が未設定です' }, 503);
  if (request.headers.get('x-cron-secret') !== env.CRON_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  const unconfigured = notConfigured(env);
  if (unconfigured) return unconfigured;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'リクエストの形式が不正です' }, 400);
  }

  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const detail = Array.isArray(body?.detail) ? body.detail : [];

  const { error } = await getSupabaseAdmin(env).from('aone_cron_log').insert({
    hour_jst: num(body?.hour, 0),
    day_jst: num(body?.day, 0),
    task_count: detail.length,
    // 1 つでも 200 以外があれば「失敗した回」として管理画面に赤で出す
    ok: detail.every((d: any) => d?.status === 200),
    detail,
  });

  if (error) {
    // 記録に失敗してもメールは送れている。cron 全体を落とさない
    console.warn('[cron/ping] 記録に失敗', error.message);
    return json({ ok: false, error: error.message }, 200);
  }
  return json({ ok: true });
};
