// Tonic service worker.
// Bump VERSION on every release: the page sees the new worker waiting and offers "Refresh".
const VERSION = 'tonic-v7';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/dsp.js',
  './js/theory.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/brand/mark-ink.svg',
  './icons/brand/full-logo-dark.svg',
  './icons/brand/full-logo-light.svg',
];
const FONT_CACHE = 'tonic-fonts';

self.addEventListener('install', (event) => {
  // Fetch past the HTTP cache so a new version never installs stale files.
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
  );
  // No skipWaiting here: the new version waits until the user taps Refresh.
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONT_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Serve this version's files from its own cache so a page never mixes versions.
  // The service worker file itself is never cached (the browser checks it directly).
  if (req.mode === 'navigate') {
    event.respondWith(caches.open(VERSION).then((c) => c.match('./index.html')).then((hit) => hit || fetch(req)));
    return;
  }
  event.respondWith(
    caches.open(VERSION).then((c) => c.match(req, { ignoreSearch: true })).then((hit) => hit || fetch(req))
  );
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => { if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()); return res; })
    .catch(() => cached);
  return cached || network;
}
