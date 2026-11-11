// 一括アップロード。画面を開いたまま実行する方式。
//  * 3 枚並列で処理 → 送信。失敗した写真だけを再送できる (成功済みは再送しない)
//  * 同じ写真 (SHA-256) はサーバー側にあれば処理せずスキップ
//  * 処理済みデータは失敗した写真だけメモリに保持 (再送のとき作り直さない)
import { processImage, sha256Hex, type Processed } from './imaging.ts';

type State = 'queued' | 'working' | 'done' | 'dup' | 'failed';
interface Item { file: File; state: State; error?: string; processed?: Processed; sha?: string; buf?: ArrayBuffer }

const CONCURRENCY = 3;
const RETRY_DELAYS = [1000, 3000, 8000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function initUploader(groupId: string) {
  const $ = (id: string) => document.getElementById(id)!;
  const input = $('pick') as HTMLInputElement, bar = $('bar'), summary = $('summary'),
        list = $('failed-list'), retryBtn = $('retry') as HTMLButtonElement, reloadBtn = $('reload');
  let items: Item[] = [];
  let known = new Set<string>();
  let running = false;
  let wake: any = null;

  const count = (s: State) => items.filter((i) => i.state === s).length;
  function render() {
    const total = items.length, done = count('done'), dup = count('dup'), failed = count('failed');
    const fin = done + dup + failed;
    (bar as HTMLElement).style.width = total ? `${Math.round((fin / total) * 100)}%` : '0%';
    summary.textContent = total
      ? `${fin} / ${total} 枚　✅ ${done}　⏭ 重複 ${dup}　❌ 失敗 ${failed}${running ? '　(アップロード中: 画面を閉じないでください)' : ''}`
      : '';
    retryBtn.hidden = running || failed === 0;
    retryBtn.textContent = `失敗した ${failed} 枚だけ再送`;
    reloadBtn.hidden = running || done + dup === 0;
    list.innerHTML = items.filter((i) => i.state === 'failed')
      .map((i) => `<div class="muted">❌ ${escapeHtml(i.file.name)} — ${escapeHtml(i.error ?? '')}</div>`).join('');
  }
  const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  async function send(it: Item): Promise<'ok' | 'duplicate'> {
    let last = '';
    for (let a = 0; a <= RETRY_DELAYS.length; a++) {
      try {
        const res = await fetch(`/api/admin/groups/${groupId}/photos`, {
          method: 'POST', body: it.processed!.body,
          headers: { 'content-type': 'application/octet-stream', 'x-photo-meta': encodeURIComponent(JSON.stringify(it.processed!.meta)) },
        });
        if (res.ok) return (((await res.json()) as any).status === 'duplicate') ? 'duplicate' : 'ok';
        last = `HTTP ${res.status}`;
        if (res.status === 401) throw new Error('ログインが切れました。再ログインして「失敗分を再送」してください');
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Error(last);
      } catch (e: any) {
        if (e?.message?.startsWith('ログイン') || e?.message?.startsWith('HTTP 4')) throw e;
        last = '通信エラー';
      }
      if (a < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[a]);
    }
    throw new Error(`${last} (自動再試行 ${RETRY_DELAYS.length} 回で失敗)`);
  }

  async function work(it: Item) {
    it.state = 'working'; it.error = undefined; render();
    try {
      if (!it.processed) {
        it.buf = await it.file.arrayBuffer();
        it.sha = await sha256Hex(it.buf);
        if (known.has(it.sha)) { it.state = 'dup'; it.buf = undefined; return; }
        it.processed = await processImage(it.file, it.buf, it.sha);
        it.buf = undefined;
      }
      const r = await send(it);
      it.state = r === 'duplicate' ? 'dup' : 'done';
      it.processed = undefined;                       // 成功したら解放
    } catch (e: any) {
      it.state = 'failed';
      it.error = e?.message === 'encode_failed' ? '画像を変換できませんでした' : (e?.message ?? '失敗');
      if (!it.processed) it.buf = undefined;          // 失敗でも処理済みなら保持 (再送が速い)
    }
  }

  async function run() {
    if (running) return;
    running = true; render();
    window.addEventListener('beforeunload', warn);
    try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* 無くてもよい */ }
    try {
      const r = await fetch(`/api/admin/groups/${groupId}/photos`);
      if (r.ok) known = new Set(((await r.json()) as any).hashes as string[]);
    } catch { /* 取れなくてもサーバー側で重複は止まる */ }
    const queue = items.filter((i) => i.state === 'queued' || i.state === 'failed');
    let idx = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (idx < queue.length) { const it = queue[idx++]; await work(it); render(); }
    }));
    running = false;
    window.removeEventListener('beforeunload', warn);
    try { await wake?.release(); } catch { /* */ }
    render();
  }
  const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|heic|heif|png)$/i.test(f.name));
    items = items.filter((i) => i.state === 'failed').concat(files.map((file) => ({ file, state: 'queued' as State })));
    input.value = '';
    run();
  });
  retryBtn.addEventListener('click', () => run());
  reloadBtn.addEventListener('click', () => location.reload());
  render();
}
