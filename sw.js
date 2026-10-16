// Pill or Rug service worker: network first, cache only as an offline fallback.
// Only same-origin GET requests for the page's own files. The score API is on another origin:
// it is never intercepted and never cached (live scores, seeds and the board always come from the network).
const CACHE = 'pillorug-v11';
const CORE = ['./', 'index.html', 'sim.js', 'score-client.js', 'manifest.webmanifest', 'brand/favicon-32.png', 'brand/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // API, fonts, anything cross-origin: browser default
  if (url.search && req.mode !== 'navigate') return;        // our files never use a query string
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? 'index.html' : req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req.mode === 'navigate' ? 'index.html' : req, { ignoreSearch: req.mode === 'navigate' }).then((r) => r || caches.match('index.html')))
  );
});
