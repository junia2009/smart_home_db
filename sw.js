/* Service Worker
 * アプリシェルは cache-first、data/*.json と config.json は network-first
 * (オフライン時はキャッシュ済みの直近データにフォールバック)。
 */
const CACHE = "env-dashboard-v5";
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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  const isData = /\/data\/.*\.json$|\/config\.json$/.test(url.pathname);
  if (isData) {
    // network-first: 最新データを優先し、失敗時のみキャッシュ
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // cache-first: アプリシェル
    event.respondWith(
      caches.match(event.request).then((hit) => hit ?? fetch(event.request))
    );
  }
});
