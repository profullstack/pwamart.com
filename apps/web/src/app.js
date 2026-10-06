import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configured, db, ping } from '@pwamart/db';
import { Hono } from 'hono';
import { api, coinpayWebhook } from './api.js';
import * as auth from './auth.js';
import { PUBLISHER_FILTERS, PUBLISHER_SORTS, categoryCounts, getApp, getPublisher, listApps, listPublishers, reviewsFor, shape } from './catalog.js';
import { CATEGORIES, config } from './config.js';
import { handleRpc } from '@profullstack/pwamart-mcp/core';
import { buildProfile } from './mobileconfig.js';
import { appPage, browsePage, developersPage, featuredPage, homePage, publishersPage, newsletterPage, notFoundPage, pricingPage, publisherPage } from './pages.js';
import * as newsletter from './newsletter.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUB = join(here, '..', 'public');
const pub = (name) => readFileSync(join(PUB, name));
const root = join(here, '..', '..', '..');
const VERSION = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
const INSTALL_SH = readFileSync(join(root, 'bin/install.sh'), 'utf8');

export const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/') || c.req.path === '/mcp') c.header('cache-control', 'no-store');
  const type = c.res.headers.get('content-type') ?? '';
  if (type.startsWith('text/html'))
    c.header(
      'content-security-policy',
      // crawlproof.com: stats.js (script + beacons) and the ad frame. Nothing else is third party.
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://crawlproof.com; connect-src 'self' https://crawlproof.com; frame-src https://crawlproof.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
});

// CORS for the read API and MCP: agents and other sites read the catalog.
app.use('/api/v1/*', async (c, next) => {
  if (c.req.method === 'OPTIONS' && c.req.header('origin')) {
    return c.body(null, 204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
  }
  await next();
  // Only bearer-key requests are cross-origin; a cookie never rides along with '*'.
  c.header('access-control-allow-origin', '*');
});

/* ---------------------------------------------------------------- stats -- */

let statsCache = { at: 0, value: { apps: 0, publishers: 0, installs: 0 } };
async function stats() {
  if (!configured()) return statsCache.value;
  if (Date.now() - statsCache.at < 60_000) return statsCache.value;
  try {
    const [s] = await db()`
      select (select count(*) from apps where status = 'published')::int as apps,
             (select count(distinct publisher_id) from apps where status = 'published')::int as publishers,
             (select coalesce(sum(installs), 0) from apps where status = 'published')::int as installs`;
    statsCache = { at: Date.now(), value: s };
  } catch {}
  return statsCache.value;
}

const html = (c, body, status = 200) => c.html(body, status, { 'cache-control': 'public, max-age=60' });

/* ---------------------------------------------------------------- pages -- */

app.get('/', async (c) => {
  const [featured, top, fresh, counts, s] = await Promise.all([
    listApps({ featured: true, limit: 4 }),
    listApps({ sort: 'top', limit: 12 }),
    listApps({ sort: 'new', limit: 8 }),
    categoryCounts(),
    stats(),
  ]);
  return html(c, homePage({ featured: featured.apps, top: top.apps, fresh: fresh.apps, counts, stats: s }));
});

app.get('/apps', async (c) => {
  const q = c.req.query('q')?.trim() || null;
  const category = CATEGORIES.some(([k]) => k === c.req.query('category')) ? c.req.query('category') : null;
  const sort = c.req.query('sort') || null;
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const limit = 24;
  const publisher = c.req.query('publisher') ? await getPublisher(c.req.query('publisher')) : null;
  const [list, counts, s] = await Promise.all([
    listApps({ q, category, publisher: publisher?.slug, sort: sort ?? 'top', limit, offset }),
    categoryCounts(),
    stats(),
  ]);
  return html(c, browsePage({ q, category, sort, list, counts, offset, limit, stats: s, publisher }));
});

app.get('/publishers', async (c) => {
  const q = c.req.query('q')?.trim().slice(0, 80) || null;
  const filter = PUBLISHER_FILTERS.includes(c.req.query('filter')) ? c.req.query('filter') : 'all';
  const sort = PUBLISHER_SORTS.includes(c.req.query('sort')) ? c.req.query('sort') : 'apps';
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const limit = 48;
  const [list, s] = await Promise.all([listPublishers({ q, filter, sort, limit, offset }), stats()]);
  return html(c, publishersPage({ q, filter, sort, list, offset, limit, stats: s }));
});

app.get('/apps/:slug', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.html(notFoundPage({ stats: await stats() }), 404);
  const a = shape(row);
  const [publisher, reviews, rel, s] = await Promise.all([
    getPublisher(a.publisher.slug),
    reviewsFor(row.id),
    listApps({ category: a.category, limit: 7 }),
    stats(),
  ]);
  const related = rel.apps.filter((x) => x.slug !== a.slug).slice(0, 6);
  return html(c, appPage({ app: a, publisher, reviews, related, stats: s }));
});

// iOS one-tap install: one app, or a bundle (?apps=a,b,c).
app.get('/apps/:slug/install.mobileconfig', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.text('no such app', 404);
  const body = await buildProfile([shape({ ...row })].map((a) => ({ ...a, icon_url: row.icon_url })), { siteUrl: config.siteUrl });
  await db()`insert into app_installs (app_id, method) values (${row.id}, 'profile')`;
  await db()`update apps set installs = installs + 1 where id = ${row.id}`;
  return c.body(body, 200, {
    'content-type': 'application/x-apple-aspen-config',
    'content-disposition': `attachment; filename="${row.slug}.mobileconfig"`,
  });
});
app.get('/bundle.mobileconfig', async (c) => {
  const slugs = String(c.req.query('apps') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 30);
  const rows = (await Promise.all(slugs.map((s) => getApp(s)))).filter(Boolean);
  if (!rows.length) return c.text('name some apps: /bundle.mobileconfig?apps=slug1,slug2', 400);
  const body = await buildProfile(rows.map((r) => ({ ...shape(r), icon_url: r.icon_url })), { siteUrl: config.siteUrl });
  return c.body(body, 200, {
    'content-type': 'application/x-apple-aspen-config',
    'content-disposition': 'attachment; filename="pwamart-bundle.mobileconfig"',
  });
});

app.get('/publishers/:slug', async (c) => {
  const p = await getPublisher(c.req.param('slug'));
  if (!p) return c.html(notFoundPage({ stats: await stats() }), 404);
  return html(c, publisherPage({ publisher: p, list: await listApps({ publisher: p.slug, limit: 100 }), stats: await stats() }));
});

app.get('/pricing', async (c) => html(c, pricingPage({ stats: await stats() })));
app.get('/developers', async (c) => html(c, developersPage({ stats: await stats() })));

/* -------------------------------------------------- featured + newsletter -- */

app.get('/featured', async (c) => {
  const [featured, counts] = configured() ? await Promise.all([listApps({ featured: true, limit: 12 }), newsletter.subscriberCounts()]) : [{ apps: [] }, { active: 0 }];
  return html(
    c,
    featuredPage({
      stats: await stats(),
      featured: featured.apps,
      subscribers: counts.active,
      priceCents: newsletter.FEATURED.priceCents,
      days: newsletter.FEATURED.days,
    }),
  );
});

// Pages that answer one person's action are never cached.
const personal = (c, page, status = 200) => c.html(page, status, { 'cache-control': 'no-store' });

app.get('/newsletter', async (c) => html(c, newsletterPage({ stats: await stats() })));
app.post('/newsletter', async (c) => {
  const form = await c.req.parseBody().catch(() => ({}));
  const r = await newsletter.subscribe(form.email, { source: String(form.source ?? 'site') });
  return personal(
    c,
    newsletterPage({
      stats: await stats(),
      notice: r.ok ? 'Almost there: tap the link in the email we just sent to confirm.' : r.error,
      tone: r.ok ? '' : 'bad',
    }),
    r.ok ? 200 : 400,
  );
});
app.get('/newsletter/confirm', async (c) => {
  const row = await newsletter.confirm(c.req.query('t'));
  return personal(
    c,
    newsletterPage({
      stats: await stats(),
      notice: row ? `You're in. ${row.email} gets the next issue.` : 'That confirmation link is not valid. Subscribe again below.',
      tone: row ? '' : 'bad',
    }),
    row ? 200 : 404,
  );
});
app.get('/newsletter/unsubscribe', async (c) => {
  const row = await newsletter.unsubscribe(c.req.query('t'));
  return personal(
    c,
    newsletterPage({
      stats: await stats(),
      notice: row ? `${row.email} is off the list. No more issues.` : 'That unsubscribe link is not valid.',
      tone: row ? '' : 'bad',
    }),
    row ? 200 : 404,
  );
});
app.get('/healthz', (c) => c.text('ok'));

/* -------------------------------------------------- console (the SPA) -- */

const shell = (c) => c.html(pub('console/index.html').toString(), 200, { 'cache-control': 'no-cache' });
for (const p of ['/console', '/console/*', '/signin']) app.get(p, shell);

const asset = (file, type, cache = 'no-cache') => (c) => c.body(pub(file), 200, { 'content-type': type, 'cache-control': cache });
app.get('/assets/store.css', asset('store.css', 'text/css; charset=utf-8'));
app.get('/assets/store.js', asset('store.js', 'text/javascript; charset=utf-8'));
app.get('/assets/console.js', asset('console/console.js', 'text/javascript; charset=utf-8'));
app.get('/assets/console.css', asset('console/console.css', 'text/css; charset=utf-8'));
const WEBAUTHN_JS = [join(here, '..', 'node_modules'), join(root, 'node_modules')]
  .map((d) => join(d, '@simplewebauthn/browser/dist/bundle/index.umd.min.js'))
  .map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  })
  .find(Boolean);
app.get('/assets/webauthn.js', (c) =>
  WEBAUTHN_JS ? c.body(WEBAUTHN_JS, 200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' }) : c.text('missing', 404),
);

// The emailed sign-in link lands here, sets the session and goes to the console.
app.get('/auth/magic', async (c) => {
  const token = c.req.query('t');
  const s = token ? await auth.consumeLoginLink(token, { userAgent: c.req.header('user-agent') }) : null;
  if (!s) return c.redirect('/signin?error=expired', 302);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  return c.redirect('/console', 302);
});

app.post('/webhooks/coinpay', coinpayWebhook);

/* --------------------------------------------------------------------- API -- */

app.get('/api/v1', (c) => c.json({ name: 'pwamart', version: VERSION, docs: `${config.siteUrl}/llms.txt`, mcp: `${config.siteUrl}/mcp` }));
app.get('/api/v1/health', async (c) => {
  const database = await ping();
  const ok = database === 'ok';
  return c.json({ ok, service: 'pwamart', version: VERSION, database }, ok ? 200 : 503);
});
app.route('/api/v1', api);

/* --------------------------------------------------------------------- MCP -- */

app.get('/mcp', (c) =>
  c.json({ name: 'pwamart', transport: 'streamable-http', endpoint: `${config.siteUrl}/mcp`, stdio: 'npx -y @profullstack/pwamart-mcp' }),
);
app.post('/mcp', async (c) => {
  let req;
  try {
    req = await c.req.json();
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  }
  const authz = c.req.header('authorization');
  const call = async (path, init = {}) => {
    const res = await app.request(`/api/v1${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(authz ? { authorization: authz } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`);
    return body;
  };
  const one = async (r) => {
    if (r?.id === undefined || r?.id === null) {
      if (typeof r?.method === 'string') return null; // a notification
    }
    try {
      return { jsonrpc: '2.0', id: r.id, result: await handleRpc(r, { call, siteUrl: config.siteUrl, version: VERSION }) };
    } catch (err) {
      return { jsonrpc: '2.0', id: r?.id ?? null, error: { code: err.code ?? -32603, message: String(err.message) } };
    }
  };
  if (Array.isArray(req)) {
    const out = (await Promise.all(req.map(one))).filter(Boolean);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await one(req);
  return out ? c.json(out) : c.body(null, 202);
});

app.notFound(async (c) =>
  c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : c.html(notFoundPage({ stats: await stats() }), 404),
);

/* ------------------------------------------------------------- PWA + misc -- */

const file = (name, type, cache = 'public, max-age=86400') => (c) => c.body(pub(name), 200, { 'content-type': type, 'cache-control': cache });
app.get('/manifest.webmanifest', file('manifest.webmanifest', 'application/manifest+json', 'no-cache'));
app.get('/sw.js', file('sw.js', 'text/javascript', 'no-cache'));
for (const f of ['icon.svg', 'favicon.svg', 'logo.svg', 'badge.svg']) app.get(`/${f}`, file(f, 'image/svg+xml'));
for (const f of ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png', 'favicon-16.png', 'favicon-32.png'])
  app.get(`/${f}`, file(f, 'image/png'));
app.get('/favicon.ico', file('favicon.ico', 'image/x-icon'));
// Store-button-size badges (135x40, like App Store / Google Play) and the install mark.
app.get('/badges/:name{[a-z0-9-]+(@[23]x)?\\.(svg|png)}', (c) => {
  const name = c.req.param('name');
  try {
    return c.body(pub(`badges/${name}`), 200, {
      'content-type': name.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    });
  } catch {
    return c.text('no such badge', 404);
  }
});
app.get('/install.sh', (c) => c.body(INSTALL_SH, 200, { 'content-type': 'text/x-shellscript' }));
app.get('/.well-known/pwamart.txt', (c) => c.text('pwamart.com lists itself.\n'));
app.get('/robots.txt', (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /console\nDisallow: /api/\nSitemap: ${config.siteUrl}/sitemap.xml\n`),
);
app.get('/sitemap.xml', async (c) => {
  const rows = configured() ? await db()`select slug, updated_at from apps where status = 'published' order by updated_at desc limit 5000` : [];
  const pubs = configured() ? await db()`select distinct p.slug from publishers p join apps a on a.publisher_id = p.id where a.status = 'published'` : [];
  const u = (loc, mod) => `<url><loc>${config.siteUrl}${loc}</loc>${mod ? `<lastmod>${new Date(mod).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
  const body = [
    u('/'),
    u('/apps'),
    u('/pricing'),
    u('/developers'),
    u('/featured'),
    u('/publishers'),
    u('/newsletter'),
    ...CATEGORIES.map(([k]) => u(`/apps?category=${k}`)),
    ...rows.map((r) => u(`/apps/${r.slug}`, r.updated_at)),
    ...pubs.map((p) => u(`/publishers/${p.slug}`)),
  ].join('');
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, 200, {
    'content-type': 'application/xml',
  });
});
app.get('/llms.txt', (c) =>
  c.text(`# pwamart

> The app store for Progressive Web Apps. Lists installable web apps and installs
> them on iPhone, Android, macOS, Windows and Linux from a browser, the CLI, the
> TUI, the desktop app, TronBrowser or an AI agent. Installing is free.

Publisher plans: Free (1 publisher, 10 apps), Pro $10/year (10 publishers, 100 apps),
Unlimited $199/year (unlimited publishers and apps, shared orgs, teams, projects).

## API (${config.siteUrl}/api/v1)
Reads are public. Writes take \`Authorization: Bearer pm_live_...\` (create one in the console under API keys).
- GET  /apps?q=&category=&publisher=&sort=top|new|rating|name&limit=&offset=
- GET  /apps/:slug                         details, publisher, reviews
- POST /apps/:slug/installs {method}       count an install
- GET  /categories, GET /plans, GET /publishers?q=&filter=all|claimed|imported|verified&sort=apps|name|new, GET /publishers/:slug
- GET  /me                                 your plan, usage, orgs and publishers
- POST /publishers {name, slug?, org?}
- POST /apps {publisher, url, category?, slug?}   inspect + create a draft
- POST /apps/:slug/verify | /refresh | /publish | /unlist | /unpublish
- PATCH /apps/:slug {name, summary, description, category, tags, project}
- POST /inspect {url}                      grade any URL's installability
- POST /orgs, /orgs/:org/invites, /orgs/:org/teams, /orgs/:org/projects   (Unlimited)
- POST /billing/checkout {plan: pro|unlimited}
- POST /apps/:slug/feature                 $19 CoinPay checkout: 7 days featured + the next newsletter issue
- GET  /apps/:slug/featured                featured state, owed newsletter slot
- POST /newsletter/subscribe {email}       double opt-in (public)

## Get featured
$19, paid once in crypto: ${config.siteUrl}/featured. Newsletter: ${config.siteUrl}/newsletter

## MCP
- Hosted: POST ${config.siteUrl}/mcp (JSON-RPC, streamable HTTP)
- stdio: npx -y @profullstack/pwamart-mcp   (PWAMART_API_KEY for publishing tools)
Tools: search_apps, get_app, list_categories, install_app, submit_app, verify_app, publish_app

## CLI + TUI
- curl -fsSL ${config.siteUrl}/install.sh | sh    (or npm i -g @profullstack/pwamart)
- pwamart search <q> | info <slug> | install <slug> | tui | submit <url> | verify <slug> | publish <slug>

## iOS
- One app: ${config.siteUrl}/apps/<slug>/install.mobileconfig
- A bundle: ${config.siteUrl}/bundle.mobileconfig?apps=a,b,c
`),
);
