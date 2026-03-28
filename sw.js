const CACHE_NAME = 'sound-of-life-v4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  // Delete all old caches so stale JS/HTML never mixes with new HTML/JS
  caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    .then(() => self.clients.matchAll({ type: 'window' }))
    .then(tabs => {
      // Tell every open tab to reload so they get fresh JS/HTML immediately.
      // Without this, users need TWO manual reloads after a deployment.
      tabs.forEach(tab => tab.postMessage({ type: 'SW_RELOAD' }));
    })
));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('opencv')) return; // OpenCV CDN — skip

  const url = new URL(e.request.url);
  const isHTML = url.pathname.endsWith('/') || url.pathname.endsWith('.html');

  if (isHTML) {
    // Network-first for HTML: always try to get the latest entry point.
    // Falls back to cache only when offline.
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first for JS/CSS/assets (Vite hashes filenames, so stale is impossible).
    e.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        const response = await fetch(e.request);
        if (response.ok) cache.put(e.request, response.clone());
        return response;
      }).catch(() => caches.match(e.request))
    );
  }
});
