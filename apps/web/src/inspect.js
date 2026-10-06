import { lookup } from 'node:dns/promises';
import { resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sharedHost } from './shared-hosts.js';

/**
 * The PWA inspector: given a URL someone submitted, fetch it the way a browser
 * would, find its web app manifest, and say whether it can be installed.
 *
 * Every fetch here is of a URL a stranger typed, so it is guarded: https only
 * (http only for localhost in tests), no private or loopback addresses on any hop,
 * redirects followed by hand so each hop is checked, a size cap and a timeout.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const UA = 'pwamart-inspector/1.0 (+https://pwamart.com/developers)';

export class InspectError extends Error {}

function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Tests point the inspector at a local server; production never allows it. */
let allowLocal = false;
export const setAllowLocal = (v) => {
  allowLocal = Boolean(v);
};

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:'))
    throw new InspectError('the app must be served over https');
  if (u.username || u.password) throw new InspectError('URLs with credentials are not accepted');
  if (allowLocal) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new InspectError(`${u.hostname} does not resolve`);
  if (addrs.some((a) => privateAddress(a.address))) throw new InspectError(`${u.hostname} is not a public address`);
  return u;
}

/** GET with every hop checked. Returns { url, status, type, text }. */
export async function safeFetch(url, { accept = '*/*', maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(current);
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    const reader = res.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new InspectError(`${new URL(current).pathname} is larger than ${maxBytes / 1024 / 1024} MB`);
        }
        chunks.push(value);
      }
    }
    const bytes = Buffer.concat(chunks);
    return { url: current, status: res.status, type: res.headers.get('content-type') ?? '', text: new TextDecoder().decode(bytes), bytes };
  }
  throw new InspectError('too many redirects');
}

/* ------------------------------------------------------------ html parsing -- */

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : null;
};
const decode = (s) =>
  s
    ?.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");

/** What the page's <head> says about itself. Regex, not a DOM: we only read tags. */
export function readHead(html, base) {
  const tags = html.match(/<(link|meta)\b[^>]*>/gi) ?? [];
  const out = { manifest: null, themeColor: null, description: null, appleIcon: null, icons: [], verify: null, ogImage: null, siteName: null };
  for (const t of tags) {
    const rel = (attr(t, 'rel') ?? '').toLowerCase().split(/\s+/);
    const name = (attr(t, 'name') ?? attr(t, 'property') ?? '').toLowerCase();
    const href = attr(t, 'href');
    const content = decode(attr(t, 'content'));
    if (rel.includes('manifest') && href) out.manifest ??= new URL(decode(href), base).href;
    if (rel.includes('apple-touch-icon') && href) out.appleIcon ??= new URL(decode(href), base).href;
    if (rel.includes('icon') && href) out.icons.push(new URL(decode(href), base).href);
    if (name === 'theme-color' && content) out.themeColor ??= content;
    if ((name === 'description' || name === 'og:description') && content) out.description ??= content;
    if (name === 'pwamart-verification' && content) out.verify = content;
    if (name === 'og:image' && content) {
      try {
        out.ogImage ??= new URL(content, base).href;
      } catch {}
    }
    if ((name === 'og:site_name' || name === 'application-name') && content) out.siteName ??= content;
  }
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  out.title = title ? decode(title[1].trim()) : null;
  out.registersServiceWorker = /serviceWorker\s*\.\s*register\s*\(/.test(html) || /\bworkbox\b/i.test(html);
  return out;
}

/* ---------------------------------------------------------- offline -- */

/**
 * The service worker URLs a page registers: `navigator.serviceWorker.register('/sw.js')`,
 * minified (`register("./sw.js",{scope:"/"})`) or `register(new URL('./sw.js', import.meta.url))`.
 * Only same-origin URLs: a browser refuses any other, so we never fetch one.
 */
export function serviceWorkerUrls(text, base) {
  const out = [];
  const origin = new URL(base).origin;
  const re = /serviceWorker\s*\.\s*register\s*\(\s*(?:new\s+URL\s*\(\s*)?(['"`])([^'"`\s]{1,300})\1/g;
  for (const m of String(text ?? '').matchAll(re)) {
    if (m[2].includes('${')) continue;
    try {
      const u = new URL(decode(m[2]), base);
      if (u.origin === origin && !out.includes(u.href)) out.push(u.href);
    } catch {}
  }
  return out;
}

/** Where service workers usually live when the page registers one from a bundle we do not read. */
export const SW_FALLBACKS = ['/sw.js', '/service-worker.js', '/serviceworker.js', '/sw.min.js'];

const FETCH_HANDLER = /addEventListener\s*\(\s*(['"`])fetch\1|\bonfetch\s*=/;

/**
 * Does this service worker script make the app work offline? It has to answer
 * requests (a fetch handler) and keep responses (the Cache API), or be Workbox,
 * which does both. A worker that only shows push notifications, or a fetch handler
 * that passes every request to the network, does not.
 */
export function classifyServiceWorker(src) {
  const s = String(src ?? '');
  if (!s.trim()) return { offline: false, reason: 'no service worker' };
  if (/\bworkbox\b|workbox-sw|precacheAndRoute|registerRoute|__WB_MANIFEST/i.test(s)) return { offline: true, reason: 'workbox' };
  if (!FETCH_HANDLER.test(s)) return { offline: false, reason: 'no fetch handler' };
  const cache = /\bcaches\s*\.\s*(open|match|keys|has)\s*\(/.test(s) || /\.addAll\s*\(/.test(s) || /cacheStorage/i.test(s);
  if (!cache) return { offline: false, reason: 'fetch handler without a cache' };
  return { offline: true, reason: 'fetch+cache' };
}

/** A real script, not an SPA's catch-all index.html or a JSON 404 served with 200. */
const looksLikeScript = (r) =>
  r && r.status < 400 && !/html|json|xml|image\//i.test(r.type) && !/^\s*</.test(r.text.slice(0, 200)) && r.text.trim().length > 0;

/**
 * Find the app's service worker and classify it. Candidates in order: what the page
 * HTML registers, the manifest's `serviceworker.src`, what one small same-origin
 * registration script registers (vite-plugin-pwa's registerSW.js), then the usual
 * paths. A few short fetches at most; never throws.
 */
export async function detectOffline({ html, pageUrl, manifest = null, manifestUrl = null, fetchFn = safeFetch, maxFetches = 4 }) {
  const origin = new URL(pageUrl).origin;
  const candidates = serviceWorkerUrls(html, pageUrl);
  const add = (u, base = origin) => {
    try {
      const h = new URL(u, base).href;
      if (new URL(h).origin === origin && !candidates.includes(h)) candidates.push(h);
    } catch {}
  };
  if (typeof manifest?.serviceworker?.src === 'string') add(manifest.serviceworker.src, manifestUrl ?? pageUrl);
  let fetches = 0;
  const get = async (u) => {
    if (fetches >= maxFetches) return null;
    fetches++;
    try {
      return await fetchFn(u, { accept: 'text/javascript,application/javascript,*/*;q=0.5', maxBytes: 1024 * 1024, timeoutMs: 5_000 });
    } catch {
      return null;
    }
  };
  if (!candidates.length) {
    const script = [...String(html ?? '').matchAll(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
      .map((m) => decode(m[1]))
      .find((s) => /register|(^|[/._-])sw([._-]|$)|service-?worker|pwa/i.test(s));
    let u = null;
    try {
      u = script ? new URL(script, pageUrl) : null;
    } catch {}
    if (u?.origin === origin) {
      const r = await get(u.href);
      if (looksLikeScript(r)) {
        if (FETCH_HANDLER.test(r.text) && !/serviceWorker\s*\.\s*register/.test(r.text)) return { ...classifyServiceWorker(r.text), sw: r.url };
        for (const v of serviceWorkerUrls(r.text, r.url)) add(v);
      }
    }
  }
  const registered = candidates.length > 0 || /serviceWorker\s*\.\s*register\s*\(/.test(String(html ?? ''));
  for (const f of SW_FALLBACKS) add(f);
  // The first worker that works offline wins; a worker that does not (a stale /sw.js
  // left behind by a rename) does not stop the search while fetches remain.
  let first = null;
  for (const u of candidates) {
    if (fetches >= maxFetches) break;
    const r = await get(u);
    if (!looksLikeScript(r) || new URL(r.url).origin !== origin) continue;
    const c = { ...classifyServiceWorker(r.text), sw: r.url };
    if (c.offline) return c;
    first ??= c;
  }
  return first ?? { offline: false, reason: registered ? 'service worker not found' : 'no service worker', sw: null };
}

/** The largest square-ish icon at or above `min`, preferring png/svg/webp. */
export function pickIcon(icons = [], min = 192) {
  const scored = icons
    .filter((i) => i?.src)
    .map((i) => {
      const sizes = String(i.sizes ?? '')
        .split(/\s+/)
        .map((s) => (s === 'any' ? 1024 : Number(s.split('x')[0]) || 0));
      return { ...i, size: Math.max(0, ...sizes), purpose: String(i.purpose ?? 'any') };
    });
  const anyPurpose = scored.filter((i) => i.purpose.split(/\s+/).includes('any'));
  const pool = anyPurpose.length ? anyPurpose : scored;
  pool.sort((a, b) => b.size - a.size);
  return pool.find((i) => i.size >= min) ?? pool[0] ?? null;
}

/**
 * A store name from a manifest. `name` is often the page title ("HQTUI — High
 * Quality Terminal UI for TypeScript"); a listing wants "HQTUI". Use the part
 * before a dash or bar, else short_name when name is long, else name.
 */
export function listingName(name, shortName) {
  const n = String(name ?? '').trim();
  const head = n.split(/\s+[—–|·]\s+|\s+-\s+|:\s+/)[0].trim();
  if (head && head.length < n.length && head.length >= 2) return head.slice(0, 60);
  if (n.length > 28 && shortName) return String(shortName).trim().slice(0, 60);
  return (n || String(shortName ?? '')).slice(0, 80);
}

/* ---------------------------------------------------------------- inspect -- */

/**
 * Fetch the page and its manifest and grade installability. Never throws for a
 * bad app: problems land in `checks` so the publisher sees all of them at once.
 * It throws only when the URL itself is unusable (not https, private, down).
 */
export async function inspect(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new InspectError('that is not a URL');
  }
  const page = await safeFetch(url.href, { accept: 'text/html,application/xhtml+xml' });
  if (page.status >= 400) throw new InspectError(`${url.href} answered HTTP ${page.status}`);
  const finalUrl = new URL(page.url);
  const head = readHead(page.text, finalUrl);

  const checks = [];
  const add = (id, ok, label, hint = '', level = 'required') => checks.push({ id, ok: Boolean(ok), label, hint, level });

  add('https', finalUrl.protocol === 'https:' || allowLocal, 'Served over HTTPS', 'Browsers only install secure origins.');

  let manifest = null;
  let manifestUrl = head.manifest;
  if (manifestUrl) {
    try {
      const m = await safeFetch(manifestUrl, { accept: 'application/manifest+json,application/json', maxBytes: 512 * 1024 });
      if (m.status < 400) manifest = JSON.parse(m.text.replace(/^﻿/, ''));
      manifestUrl = m.url;
    } catch {
      manifest = null;
    }
  }
  add('manifest', manifest, 'Links a web app manifest', 'Add <link rel="manifest" href="/manifest.webmanifest"> to the page head.');

  const mf = manifest ?? {};
  const resolve = (v) => {
    try {
      return v ? new URL(v, manifestUrl ?? finalUrl).href : null;
    } catch {
      return null;
    }
  };
  const icons = (Array.isArray(mf.icons) ? mf.icons : []).map((i) => ({ ...i, src: resolve(i.src) }));
  const big = pickIcon(icons, 512);
  const sizes = icons.flatMap((i) => String(i.sizes ?? '').split(/\s+/));
  const startUrl = resolve(mf.start_url) ?? finalUrl.href;
  const display = mf.display_override?.[0] ?? mf.display ?? 'browser';

  add('name', mf.name || mf.short_name, 'Has a name', 'Set "name" (and "short_name") in the manifest.');
  add('icon192', sizes.includes('192x192') || sizes.includes('any'), 'Has a 192px icon', 'Add a 192x192 PNG to "icons".');
  add('icon512', sizes.includes('512x512') || sizes.includes('any'), 'Has a 512px icon', 'Add a 512x512 PNG to "icons".');
  add('display', ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay', 'tabbed'].includes(display),
    'Opens in its own window', 'Set "display": "standalone".');
  add('start_url', startUrl && new URL(startUrl).origin === finalUrl.origin, 'Start URL on the same origin', 'start_url must stay on the app\'s own origin.');
  const offline = await detectOffline({ html: page.text, pageUrl: finalUrl.href, manifest, manifestUrl });
  add('sw', head.registersServiceWorker || Boolean(offline.sw), 'Registers a service worker',
    'Not required by Chrome since 2023, but it is what makes an app work offline.', 'recommended');
  add('offline', offline.offline, 'Works offline',
    offline.offline
      ? `Its service worker answers requests from a cache (${offline.reason}).`
      : `Not detected (${offline.reason}). Cache the app shell in the service worker and answer fetch events from that cache; Workbox's precacheAndRoute does both.`,
    'recommended');
  add('maskable', icons.some((i) => String(i.purpose ?? '').includes('maskable')), 'Has a maskable icon',
    'Android crops icons to a shape; a maskable icon keeps the art inside the safe zone.', 'recommended');
  add('screenshots', Array.isArray(mf.screenshots) && mf.screenshots.length > 0, 'Has screenshots',
    'Screenshots in the manifest show on the details page and in the browser\'s richer install dialog.', 'recommended');
  add('description', mf.description || head.description, 'Has a description', 'Set "description" in the manifest.', 'recommended');
  add('id', mf.id, 'Has a manifest id', 'An "id" keeps the install stable if start_url ever changes.', 'recommended');

  const required = checks.filter((c) => c.level === 'required');
  return {
    url: finalUrl.href,
    origin: finalUrl.origin,
    installable: required.every((c) => c.ok),
    score: Math.round((checks.filter((c) => c.ok).length / checks.length) * 100),
    checks,
    manifestUrl: manifest ? manifestUrl : null,
    manifest,
    offline,
    features: offline.offline ? ['offline'] : [],
    app: {
      name: listingName(mf.name || head.title || finalUrl.hostname, mf.short_name),
      fullName: mf.name || null,
      shortName: mf.short_name || null,
      description: mf.description || head.description || null,
      startUrl,
      manifestId: resolve(mf.id) ?? startUrl,
      icon: big?.src ?? head.appleIcon ?? head.icons[0] ?? null,
      themeColor: mf.theme_color || head.themeColor || null,
      backgroundColor: mf.background_color || null,
      display,
      categories: Array.isArray(mf.categories) ? mf.categories.map(String) : [],
      screenshots: (Array.isArray(mf.screenshots) ? mf.screenshots : [])
        .map((s) => ({ src: resolve(s.src), sizes: s.sizes ?? null, label: s.label ?? null, form: s.form_factor ?? null }))
        .filter((s) => s.src)
        .slice(0, 8),
    },
    verifyMeta: head.verify,
  };
}

/** Inspection -> the apps columns the feature filters read. */
export function featureColumns(r) {
  return { features: r.features ?? [], offline_reason: r.offline?.reason ?? null, features_checked_at: new Date() };
}

/* ------------------------------------------------------- domain ownership -- */

/** The token an app's manifest carries: `"pwamart": { "verification": "<token>" }`. */
export function manifestToken(manifest) {
  const v = manifest?.pwamart?.verification;
  return typeof v === 'string' ? v.trim() : null;
}

/**
 * Does the origin carry this token? Four ways, first match wins:
 *   https://<origin>/.well-known/pwamart.txt   containing the token
 *   <meta name="pwamart-verification" content="<token>"> on the submitted page
 *   "pwamart": { "verification": "<token>" }   in the app's web app manifest
 *   DNS TXT  _pwamart.<host>  =  pwamart-verification=<token>
 *
 * DNS is never asked on a shared host (you.vercel.app): its owner cannot write
 * that zone, so the answer could only ever come from the platform.
 */
export async function verifyOrigin({ origin, url, token, txt = resolveTxt }) {
  try {
    const f = await safeFetch(`${origin}/.well-known/pwamart.txt`, { maxBytes: 16 * 1024 });
    if (f.status < 400 && f.text.includes(token)) return 'well-known';
  } catch {}
  try {
    const p = await safeFetch(url, { accept: 'text/html' });
    const head = readHead(p.text, new URL(p.url));
    if (head.verify === token) return 'meta';
    if (head.manifest) {
      const m = await safeFetch(head.manifest, { accept: 'application/manifest+json,application/json', maxBytes: 512 * 1024 });
      if (m.status < 400 && manifestToken(JSON.parse(m.text.replace(/^﻿/, ''))) === token) return 'manifest';
    }
  } catch {}
  const host = new URL(origin).hostname;
  if (sharedHost(host)) return null;
  try {
    const records = (await txt(`_pwamart.${host}`)).map((r) => r.join(''));
    if (records.some((r) => r.trim() === `pwamart-verification=${token}`)) return 'dns';
  } catch {}
  return null;
}
