/* ウォーキング計測 — Service Worker
 * アプリ本体をキャッシュしてオフラインでも起動できるようにする。
 * 地図タイルは閲覧したぶんだけ実行時にキャッシュ(オフラインで再表示可)。
 * ユーザーデータ(体重・履歴)はlocalStorageにあり、ここでは扱わない。
 */
const VERSION = 'v1';
const SHELL_CACHE = `walkcal-shell-${VERSION}`;
const TILE_CACHE = `walkcal-tiles-${VERSION}`;
const TILE_LIMIT = 400; // タイルキャッシュの最大枚数

const SHELL_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // 個別に追加し、CDN等が一部失敗しても全体が止まらないようにする
      Promise.allSettled(SHELL_ASSETS.map((url) =>
        cache.add(new Request(url, { cache: 'reload' }))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
        .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org/.test(url) || /tile\.openstreetmap/.test(url);
}

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxItems) {
    for (let i = 0; i < keys.length - maxItems; i++) await cache.delete(keys[i]);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = request.url;

  // 地図タイル: cache-first + 実行時キャッシュ
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const res = await fetch(request);
          if (res && res.status === 200) {
            cache.put(request, res.clone());
            trimCache(TILE_CACHE, TILE_LIMIT);
          }
          return res;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // それ以外(アプリ本体・Leaflet): cache-first、なければネットワーク
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res && res.status === 200 && (url.startsWith(self.location.origin) || url.includes('unpkg.com'))) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
