// テレビ用 Service Worker: 通信が切れても直近の写真・画面で表示を続ける
const C = 'tv-v1';
const MAX_IMAGES = 600;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== C).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

async function trim(cache) {
  const keys = await cache.keys();
  const imgs = keys.filter((r) => r.url.includes('/img/'));
  for (const r of imgs.slice(0, Math.max(0, imgs.length - MAX_IMAGES))) await cache.delete(r);
}

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || !u.pathname.startsWith('/tv/')) return;
  if (u.pathname.includes('/img/')) {            // 画像: キャッシュ優先
    e.respondWith(caches.open(C).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { c.put(e.request, res.clone()); trim(c); }
      return res;
    }));
  } else {                                        // 画面・状態: 通信優先、だめなら直近のキャッシュ
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(C).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || new Response('offline', { status: 503 }))));
  }
});
