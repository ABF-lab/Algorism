/**
 * sw.js — offline app shell.
 *
 * Cache-first for the shell, because the field has no connectivity. Model calls
 * are NEVER cached: a stale vital sign is a clinical hazard.
 *
 * Bump CACHE on every deploy. A cache-first worker that serves yesterday's
 * JavaScript forever looks exactly like "my changes did nothing".
 */

const CACHE = 'sehat-v1';

const SHELL = [
  './',
  './index.html',
  './app.js',
  './clinical.js',
  './ledger.js',
  './ai.js',
  './styles.css',
  './manifest.webmanifest',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic: one 404 and nothing caches. Fetch individually so a
      // single missing optional asset cannot break offline install.
      .then((cache) => Promise.all(
        SHELL.map((url) => cache.add(url).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Model calls and any other cross-origin request go straight to the network.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Serve immediately, then refresh in the background so the next load
        // is current without ever blocking this one.
        event.waitUntil(refresh(request));
        return hit;
      }
      return fetch(request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});

function refresh(request) {
  return fetch(request)
    .then((res) => {
      if (res && res.ok) return caches.open(CACHE).then((c) => c.put(request, res));
    })
    .catch(() => {});
}
