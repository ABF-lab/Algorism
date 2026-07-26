/**
 * sw.js — offline app shell.
 */

const CACHE = 'sehat-v5';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './clinical.js',
  './ledger.js',
  './ai.js',
  './sync.js',
  './manifest.webmanifest',
  './icon.svg',
  './assets/bg.jpg',
  './assets/bg-mobile.jpg',
  './fonts/inter.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
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

  // Model calls and Supabase sync calls go straight to the network.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('generativelanguage.googleapis.com') || url.hostname.includes('supabase.co')) return;

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
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
