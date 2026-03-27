const CACHE_NAME = 'sound-of-life-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Skip OpenCV (~8 MB CDN file) — always fetch fresh
  if (e.request.url.includes('opencv')) return;
  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
      if (cached) return cached;
      const response = await fetch(e.request);
      if (response.ok) cache.put(e.request, response.clone());
      return response;
    }).catch(() => caches.match(e.request))
  );
});
