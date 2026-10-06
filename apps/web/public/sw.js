// pwamart service worker. Static assets: cache first, refreshed in the background.
// Pages and the API: network first, so a listing is never stale; the last copy of a
// page is the offline fallback. Bump VERSION when an asset changes shape.
const VERSION = 'pwamart-v2';

// Push: "Get notified" releases (handlers from @profullstack/notifications).
importScripts('/assets/push-sw.js');
self.PushHandlers.installPushHandlers(self, { icon: '/icon-192.png', badge: '/favicon-32.png' });
const ASSETS = ['/assets/store.css', '/assets/store.js', '/icon.svg', '/favicon.svg', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.endsWith('.mobileconfig')) return;

  if (ASSETS.includes(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit ?? fresh;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
          return res;
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match('/')) ?? Response.error()),
    );
  }
});
