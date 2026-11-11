// 一括アップロード (100 枚程度を前提)。画面を開いたまま実行する方式。
//
// メモリ対策 (iPhone Safari):
//   * 画像の変換 (デコード → 原本/プレビュー/サムネ作成) は **1 枚ずつ**。12MP の展開だけで
//     約 50MB 使うため、並列にすると数百 MB になりタブごと落ちる
//   * 変換済みデータは最大 3 枚分だけ溜める。送信が追いつかなければ変換を待たせる
//   * 失敗した写真の変換済みデータを残すのは 8 枚まで (通信が長く切れても溜め込まない)
// 通信対策:
//   * 送信は 3 並列。1 回ごとにタイムアウト (90 秒)、自動再試行 3 回 (1 秒・3 秒・8 秒)
//   * オフラインの間は送信を止めて待つ (再試行の回数を消費しない)。復帰したら自動で再開
//   * 失敗した写真だけを再送できる。成功済みは再送しない
//   * 画面が落ちた/再読込したあとに同じ写真を選び直しても、送信済みの写真は読み込まずに飛ばす
import { processImage, sha256Hex, type DecodeVia, type Processed } from './imaging.ts';

type State = 'queued' | 'working' | 'done' | 'dup' | 'failed';
interface Item { file: File; state: State; error?: string; processed?: Processed; sha?: string; key: string }

const UPLOAD_CONCURRENCY = 3;
const READY_MAX = 3;
const KEEP_FAILED_PAYLOADS = 8;
const RETRY_DELAYS = [1000, 3000, 8000];
const REQUEST_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function initUploader(groupId: string) {
  const $ = (id: string) => document.getElementById(id)!;
  const input = $('pick') as HTMLInputElement, bar = $('bar'), summary = $('summary'),
        list = $('failed-list'), retryBtn = $('retry') as HTMLButtonElement, reloadBtn = $('reload'),
        net = $('net');
  let items: Item[] = [];
  let known = new Set<string>();
  let running = false;
  let wake: any = null;
  const via: Record<DecodeVia, number> = { jpeg: 0, 'heic-native': 0, 'heic-wasm': 0 };

  // 送信済みの写真 (名前+サイズ+更新日時)。ページを開き直したあとの再選択で、読み込みを省く
  const doneKey = `uploaded:${groupId}`;
  let doneKeys = new Set<string>();
  try { doneKeys = new Set(JSON.parse(localStorage.getItem(doneKey) ?? '[]')); } catch { /* 使えなくてもよい */ }
  const remember = (k: string) => {
    doneKeys.add(k);
    try { localStorage.setItem(doneKey, JSON.stringify([...doneKeys].slice(-3000))); } catch { /* */ }
  };

  const count = (s: State) => items.filter((i) => i.state === s).length;
  const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  function render() {
    const total = items.length, done = count('done'), dup = count('dup'), failed = count('failed');
    const fin = done + dup + failed;
    (bar as HTMLElement).style.width = total ? `${Math.round((fin / total) * 100)}%` : '0%';
    const heic = via['heic-native'] + via['heic-wasm'];
    summary.textContent = total
      ? `${fin} / ${total} 枚　✅ ${done}　⏭ 重複 ${dup}　❌ 失敗 ${failed}` +
        (heic ? `　(HEIC ${heic} 枚は端末で変換)` : '') +
        (running ? '　アップロード中: この画面を閉じないでください' : '')
      : '';
    retryBtn.hidden = running || failed === 0;
    retryBtn.textContent = `失敗した ${failed} 枚だけ再送`;
    reloadBtn.hidden = running || done + dup === 0;
    list.innerHTML = items.filter((i) => i.state === 'failed')
      .map((i) => `<div class="muted">❌ ${escapeHtml(i.file.name)} — ${escapeHtml(i.error ?? '')}</div>`).join('');
  }
  const setNet = (msg: string) => { net.textContent = msg; net.hidden = !msg; };

  /** オフラインの間は待つ (送信の失敗にも再試行回数にも数えない) */
  async function whenOnline() {
    while (!navigator.onLine) {
      setNet('📵 通信が切れています。つながると自動で再開します (画面は閉じないでください)');
      await new Promise<void>((r) => window.addEventListener('online', () => r(), { once: true }));
    }
    setNet('');
  }

  async function send(it: Item): Promise<'ok' | 'duplicate'> {
    let last = '';
    for (let a = 0; a <= RETRY_DELAYS.length; a++) {
      await whenOnline();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`/api/admin/groups/${groupId}/photos`, {
          method: 'POST', body: it.processed!.body, signal: ac.signal,
          headers: { 'content-type': 'application/octet-stream', 'x-photo-meta': encodeURIComponent(JSON.stringify(it.processed!.meta)) },
        });
        if (res.ok) return ((await res.json()) as any).status === 'duplicate' ? 'duplicate' : 'ok';
        last = `HTTP ${res.status}`;
        if (res.status === 401) throw new Error('ログインが切れました。再ログインして「失敗分を再送」してください');
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new Error(last);
      } catch (e: any) {
        if (e?.message?.startsWith('ログイン') || e?.message?.startsWith('HTTP 4')) throw e;
        last = e?.name === 'AbortError' ? '通信がタイムアウト' : '通信エラー';
      } finally { clearTimeout(timer); }
      if (a < RETRY_DELAYS.length) await sleep(RETRY_DELAYS[a]);
    }
    throw new Error(`${last} (自動再試行 ${RETRY_DELAYS.length} 回で失敗)`);
  }

  const fail = (it: Item, e: any) => {
    it.state = 'failed';
    const m = e?.message ?? '失敗';
    it.error = m === 'encode_failed' ? '画像を変換できませんでした'
      : m === 'heic_decode' ? 'HEIC を読み込めませんでした'
      : /memory|allocation/i.test(m) ? 'メモリ不足 (少なめに選び直してください)' : m;
  };

  /** 1 枚の準備: 送信済み/重複の判定 → 変換 */
  async function prepare(it: Item): Promise<boolean> {
    it.state = 'working'; it.error = undefined; render();
    if (doneKeys.has(it.key)) { it.state = 'dup'; return false; }
    if (it.processed) return true;                              // 失敗後の再送 (変換済み)
    try {
      const buf = await it.file.arrayBuffer();
      it.sha = await sha256Hex(buf);
      if (known.has(it.sha)) { it.state = 'dup'; remember(it.key); return false; }
      it.processed = await processImage(it.file, buf, it.sha);
      via[it.processed.via]++;
      return true;
    } catch (e) { fail(it, e); return false; }
  }

  async function upload(it: Item) {
    try {
      const r = await send(it);
      it.state = r === 'duplicate' ? 'dup' : 'done';
      it.processed = undefined;
      remember(it.key);
    } catch (e) {
      fail(it, e);
      // 変換済みデータを残すのは一部だけ (メモリを溜め込まない)
      if (items.filter((x) => x.state === 'failed' && x.processed).length > KEEP_FAILED_PAYLOADS) it.processed = undefined;
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
    const ready: Item[] = [];
    let producerDone = false;

    const producer = async () => {
      for (const it of queue) {
        while (ready.length >= READY_MAX) await sleep(40);     // 送信が追いつくまで変換を待つ
        if (await prepare(it)) ready.push(it);
        render();
        await sleep(0);                                         // UI とガベージコレクションに隙間を作る
      }
      producerDone = true;
    };
    const uploader = async () => {
      for (;;) {
        const it = ready.shift();
        if (!it) { if (producerDone) return; await sleep(40); continue; }
        await upload(it); render();
      }
    };
    await Promise.all([producer(), ...Array.from({ length: UPLOAD_CONCURRENCY }, uploader)]);

    running = false;
    window.removeEventListener('beforeunload', warn);
    setNet('');
    try { await wake?.release(); } catch { /* */ }
    render();
  }
  const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|heic|heif|png)$/i.test(f.name));
    items = items.filter((i) => i.state === 'failed')
      .concat(files.map((file) => ({ file, state: 'queued' as State, key: `${file.name}|${file.size}|${file.lastModified}` })));
    input.value = '';
    run();
  });
  retryBtn.addEventListener('click', () => run());
  reloadBtn.addEventListener('click', () => location.reload());
  // 画面を一度閉じた (ロックした) 場合は、戻ったときに案内する
  document.addEventListener('visibilitychange', () => { if (!document.hidden && running) setNet('画面に戻りました。アップロードを続けています'); });
  render();
}
