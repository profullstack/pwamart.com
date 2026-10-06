import { describe, expect, test } from 'bun:test';
import { classifyServiceWorker, detectOffline, serviceWorkerUrls } from '../apps/web/src/inspect.js';

describe('offline detection', () => {
  const base = 'https://a.example/app/';

  test('serviceWorkerUrls reads register() calls, same origin only', () => {
    const html = `<script>navigator.serviceWorker.register('/sw.js')</script>
      <script>if('serviceWorker' in navigator){navigator.serviceWorker.register("./worker.js",{scope:"./"})}</script>
      <script type="module">navigator.serviceWorker.register(new URL('../pwa/sw.js', import.meta.url))</script>
      <script>navigator.serviceWorker.register(\`/tpl-\${v}.js\`); navigator.serviceWorker.register('https://evil.example/sw.js')</script>
      <script>navigator.serviceWorker.register('/sw.js')</script>`;
    expect(serviceWorkerUrls(html, base)).toEqual(['https://a.example/sw.js', 'https://a.example/app/worker.js', 'https://a.example/pwa/sw.js']);
    expect(serviceWorkerUrls('<p>no worker</p>', base)).toEqual([]);
  });

  test('Workbox is offline', () => {
    expect(
      classifyServiceWorker(
        "importScripts('https://storage.googleapis.com/workbox-cdn/releases/6.5.4/workbox-sw.js'); workbox.routing.registerRoute(/x/, new workbox.strategies.CacheFirst())",
      ),
    ).toEqual({ offline: true, reason: 'workbox' });
    expect(classifyServiceWorker('precacheAndRoute(self.__WB_MANIFEST)').offline).toBe(true);
  });

  test('a fetch handler that answers from caches is offline', () => {
    const sw = `self.addEventListener('install', e => e.waitUntil(caches.open('v1').then(c => c.addAll(['/']))));
      self.addEventListener("fetch", e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));`;
    expect(classifyServiceWorker(sw)).toEqual({ offline: true, reason: 'fetch+cache' });
    expect(classifyServiceWorker('self.onfetch = (e) => e.respondWith(caches.match(e.request))').offline).toBe(true);
  });

  test('a pass-through fetch handler, a push-only worker and no worker are not', () => {
    expect(classifyServiceWorker("self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)))")).toEqual({
      offline: false,
      reason: 'fetch handler without a cache',
    });
    expect(classifyServiceWorker("self.addEventListener('push', (e) => self.registration.showNotification('hi'))")).toEqual({
      offline: false,
      reason: 'no fetch handler',
    });
    expect(classifyServiceWorker('')).toEqual({ offline: false, reason: 'no service worker' });
  });

  const fake = (files, seen = []) => async (url) => {
    seen.push(new URL(url).pathname);
    const f = files[new URL(url).pathname];
    if (!f) return { url, status: 404, type: 'text/html', text: '<!doctype html>not found' };
    return { url, status: 200, type: f.type ?? 'text/javascript', text: f.text };
  };

  test('detectOffline fetches the registered worker, once', async () => {
    const seen = [];
    const r = await detectOffline({
      html: "<script>navigator.serviceWorker.register('/app/worker.js')</script>",
      pageUrl: base,
      fetchFn: fake({ '/app/worker.js': { text: 'precacheAndRoute(self.__WB_MANIFEST)' } }, seen),
    });
    expect(r).toEqual({ offline: true, reason: 'workbox', sw: 'https://a.example/app/worker.js' });
    expect(seen).toEqual(['/app/worker.js']);
  });

  test('detectOffline falls back to the usual paths; an SPA index.html there is not a worker', async () => {
    const found = await detectOffline({
      html: '<p>a bundle registers it</p>',
      pageUrl: base,
      fetchFn: fake({ '/service-worker.js': { text: "addEventListener('fetch',e=>e.respondWith(caches.match(e.request)))" } }),
    });
    expect(found.offline).toBe(true);
    expect(found.sw).toBe('https://a.example/service-worker.js');
    const spa = await detectOffline({ html: '<p>x</p>', pageUrl: base, fetchFn: fake({ '/sw.js': { type: 'text/html', text: '<!doctype html><div id=app>' } }) });
    expect(spa).toEqual({ offline: false, reason: 'no service worker', sw: null });
  });

  test('detectOffline reads a linked registration script and the manifest serviceworker', async () => {
    const viaScript = await detectOffline({
      html: '<script id="vite-plugin-pwa:register-sw" src="/registerSW.js"></script>',
      pageUrl: base,
      fetchFn: fake({ '/registerSW.js': { text: "navigator.serviceWorker.register('/my-sw.js',{scope:'/'})" }, '/my-sw.js': { text: 'workbox' } }),
    });
    expect(viaScript).toEqual({ offline: true, reason: 'workbox', sw: 'https://a.example/my-sw.js' });
    const viaManifest = await detectOffline({
      html: '',
      pageUrl: base,
      manifest: { serviceworker: { src: 'w.js' } },
      manifestUrl: 'https://a.example/m/manifest.json',
      fetchFn: fake({ '/m/w.js': { text: "self.addEventListener('fetch', e => {})" } }),
    });
    expect(viaManifest).toEqual({ offline: false, reason: 'fetch handler without a cache', sw: 'https://a.example/m/w.js' });
  });
});
