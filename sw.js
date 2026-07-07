/* Service Worker
 * 全リクエスト network-first: オンラインなら常に最新を配信し、
 * 取得成功時にキャッシュを更新。オフライン時のみキャッシュにフォールバック。
 * (シェルを cache-first にすると新バージョンが届かない問題があったため)
 */
const CACHE = "env-dashboard-v6";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // ナビゲーションはトップページにフォールバック(オフライン起動用)
    if (request.mode === "navigate") {
      const top = await cache.match("./");
      if (top) return top;
    }
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(networkFirst(event.request));
});
