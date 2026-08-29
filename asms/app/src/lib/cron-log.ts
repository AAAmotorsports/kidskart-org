/**
 * Cloudflare Workers Cron Triggers の実行履歴を DB に記録するヘルパ。
 * /api/cron/*.ts から使う。
 *
 * 使い方:
 *   return await logCronRun(supabase, 'thankyou-mail', async () => {
 *     // ... 送信ロジック ...
 *     return { total, sent, skipped, failed };  // ← summary jsonb に入る
 *   });
 *
 * - 開始時に status='running' で 1 行 insert
 * - 成功時に status='success' + summary + duration_ms
 * - 例外時に status='error' + error_message + duration_ms
 * - どちらでも finished_at を埋める
 *
 * ヘルパ自体の失敗 (Supabase 到達不能等) はログに残せないので
 * console.warn だけして例外は握らない (本来の cron ロジックは走らせる)。
 */

type SupabaseAdmin = any; // 型循環回避のため any にする (実体は SupabaseClient)

export async function logCronRun<T>(
  supabase: SupabaseAdmin,
  cronName: string,
  worker: () => Promise<T>,
): Promise<T> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // 開始行を先に insert しておく (途中で Worker が死んだ場合でも「走った痕跡」が残る)
  let rowId: string | null = null;
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .insert({
        cron_name: cronName,
        started_at: startedAt,
        status: 'running',
      })
      .select('id')
      .single();
    if (error) throw error;
    rowId = data?.id ?? null;
  } catch (e) {
    console.warn(`[cron-log] failed to insert starting row for ${cronName}:`, e);
    // ヘルパ側の失敗は本来のロジックを止めないので、rowId 無しで進める
  }

  try {
    const result = await worker();
    const durationMs = Date.now() - startTime;

    if (rowId) {
      const { error } = await supabase
        .from('cron_runs')
        .update({
          finished_at: new Date().toISOString(),
          status: 'success',
          summary: result as any,
          duration_ms: durationMs,
        })
        .eq('id', rowId);
      if (error) console.warn(`[cron-log] failed to update success row for ${cronName}:`, error);
    }
    return result;
  } catch (e: any) {
    const durationMs = Date.now() - startTime;
    const message = e?.message ?? String(e);

    if (rowId) {
      const { error } = await supabase
        .from('cron_runs')
        .update({
          finished_at: new Date().toISOString(),
          status: 'error',
          error_message: message.slice(0, 2000),
          duration_ms: durationMs,
        })
        .eq('id', rowId);
      if (error) console.warn(`[cron-log] failed to update error row for ${cronName}:`, error);
    }
    throw e;
  }
}
