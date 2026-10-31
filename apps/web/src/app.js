import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configured, db, ping } from '@pwamart/db';
import { Hono } from 'hono';
import { api, coinpayWebhook } from './api.js';
import * as auth from './auth.js';
import { getCookie } from 'hono/cookie';
import { mountOAuth } from './oauth.js';
import { mountCoinPaySignin } from './coinpay-signin.js';
import { PUBLISHER_FILTERS, PUBLISHER_SORTS, categoryCounts, featureCounts, featureKey, surfaceCounts, getApp, getPublisher, listApps, listPublishers, reviewsFor, shape } from './catalog.js';
import { CATEGORIES, config } from './config.js';
import { handleRpc } from '@profullstack/pwamart-mcp/core';
import { buildProfile } from './mobileconfig.js';
import { advertisePage, appPage, invitePage, leaderboardPage, leaderboardProfilePage, collectionPage, collectionsPage, layout, releasesPage, browsePage, developersPage, featuredPage, homePage, publishersPage, newsletterPage, notFoundPage, pricingPage, publisherPage } from './pages.js';
import { rss } from './releases.js';
import { COLLECTIONS, SECTIONS, allCollections, collectionApps, getCollection, installScript, mcpConfig, pick, summarize } from './collections.js';
import { surfaceKey } from './surfaces.js';
import { refreshFooter } from './footer.js';
import { trafficGuard } from './throttle.js';
import { appBadgeRow, appBySite, badgeSvg, listBadgeSvg, squareBadgeIconData, squareIconBadgeSvg, theme as badgeTheme } from './badge.js';
import { networkStats } from './crawlproof.js';
import * as newsletter from './newsletter.js';
import * as karma from './karma.js';
import { commentsFor } from './community.js';
import { leaderboard as leaderboardMiddleware } from '@profullstack/leaderboard/hono';
import { saveSignupProfile } from '@profullstack/profile';
import { PROFILE_ENHANCE_SCRIPT, profileTemplate, profiles } from './user-profile.js';
import * as credits from './credits.js';

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

// Crawl gateway + app-wide throttle (x402 pass instead of a 429): see throttle.js.
app.use('*', trafficGuard());

// The shared footer's template refreshes from jsDelivr at most hourly; await it
// here so the synchronous page templates always have a current copy.
app.use('*', async (c, next) => {
  if (c.req.method === 'GET') await refreshFooter();
  await next();
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

// ?ref=<affiliate code> on any page: remembered for 30 days, first touch wins
// (an existing cookie is never overwritten). Only a new account ever uses it.
app.use('*', async (c, next) => {
  await next();
  if (c.req.method !== 'GET') return;
  const ref = credits.cleanRef(c.req.query('ref'));
  if (!ref || getCookie(c, credits.REF_COOKIE)) return;
  c.header('set-cookie', `${credits.REF_COOKIE}=${ref}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${config.isProd ? '; Secure' : ''}`, { append: true });
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
  const [featured, top, fresh, counts, features, surfaces, collections, s] = await Promise.all([
    listApps({ featured: true, limit: 4 }),
    listApps({ sort: 'top', limit: 12 }),
    listApps({ sort: 'new', limit: 8 }),
    categoryCounts(),
    featureCounts(),
    surfaceCounts(),
    allCollections(config.siteUrl),
    stats(),
  ]);
  const top5 = await karma.topKarma({ limit: 5 }).catch(() => null);
  const workflows = collections.filter((x) => x.section === 'workflows');
  return html(c, homePage({ featured: featured.apps, top: top.apps, fresh: fresh.apps, counts, features, surfaces, collections: workflows, stats: s, karma: top5 }));
});

app.get('/apps', async (c) => {
  const q = c.req.query('q')?.trim() || null;
  const category = CATEGORIES.some(([k]) => k === c.req.query('category')) ? c.req.query('category') : null;
  const sort = c.req.query('sort') || null;
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const limit = 24;
  const publisher = c.req.query('publisher') ? await getPublisher(c.req.query('publisher')) : null;
  const feature = featureKey(c.req.query('feature')) ?? (c.req.query('offline') === '1' ? 'offline' : null);
  const surface = surfaceKey(c.req.query('surface'));
  const [list, counts, features, surfaces, s] = await Promise.all([
    listApps({ q, category, publisher: publisher?.slug, feature, surface, sort: sort ?? 'top', limit, offset }),
    categoryCounts(),
    featureCounts(),
    surfaceCounts(),
    stats(),
  ]);
  return html(c, browsePage({ q, category, sort, list, counts, offset, limit, stats: s, publisher, feature, features, surface, surfaces }));
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
  const [publisher, reviews, comments, rel, s] = await Promise.all([
    getPublisher(a.publisher.slug),
    reviewsFor(row.id),
    commentsFor(row.id),
    listApps({ category: a.category, limit: 7 }),
    stats(),
  ]);
  const related = rel.apps.filter((x) => x.slug !== a.slug).slice(0, 6);
  const releases = await db()`select * from app_releases where app_id = ${row.id} order by created_at desc limit 3`;
  return html(c, appPage({ app: a, publisher, reviews, comments, related, releases, stats: s }));
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

/* ---------------------------------------------------------- collections -- */

app.get('/collections', async (c) => {
  const [all, s] = await Promise.all([allCollections(config.siteUrl), stats()]);
  const members = new Map(all.flatMap((x) => x.apps.map((a) => [a.slug, a])));
  const has = (k) => [...members.values()].filter((a) => a.surfaces?.[k]).length;
  const sections = SECTIONS.map(([key, title]) => ({ title, collections: all.filter((x) => x.section === key) }));
  return html(c, collectionsPage({ sections, totals: { collections: all.length, apps: members.size, cli: has('cli'), mcp: has('mcp') }, stats: s }));
});

app.get('/collections/:slug', async (c) => {
  const col = getCollection(c.req.param('slug'));
  if (!col) return c.html(notFoundPage({ stats: await stats() }), 404);
  const [apps, s] = await Promise.all([collectionApps(col), stats()]);
  if (!apps.length) return c.html(notFoundPage({ stats: s }), 404);
  return html(c, collectionPage({ col, summary: summarize(col, apps, config.siteUrl), apps, stats: s }));
});

// One script for every member's CLI (?apps=a,b for some of them); `curl ... | sh` runs it.
app.get('/collections/:slug/install.sh', async (c) => {
  const col = getCollection(c.req.param('slug'));
  if (!col) return c.text('echo "no such collection" >&2; exit 1\n', 404);
  const apps = pick(await collectionApps(col), c.req.query('apps'));
  return c.body(installScript(col, apps, config.siteUrl), 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'public, max-age=300' });
});

// Every member's MCP server as one mcpServers config (?apps=a,b for some of them).
app.get('/collections/:slug/mcp.json', async (c) => {
  const col = getCollection(c.req.param('slug'));
  if (!col) return c.json({ error: 'no such collection' }, 404);
  const apps = pick(await collectionApps(col), c.req.query('apps'));
  return c.json(mcpConfig(apps), 200, { 'cache-control': 'public, max-age=300' });
});

app.get('/publishers/:slug', async (c) => {
  const p = await getPublisher(c.req.param('slug'));
  if (!p) return c.html(notFoundPage({ stats: await stats() }), 404);
  return html(c, publisherPage({ publisher: p, list: await listApps({ publisher: p.slug, limit: 100 }), stats: await stats() }));
});

/* ---------------------------------------------------------- leaderboard -- */

// Our page, in the site layout; the package serves the JSON, RSS, share cards and widget.
app.get('/leaderboard', async (c) => {
  const period = ['week', 'month', 'all'].includes(c.req.query('period')) ? c.req.query('period') : 'week';
  const lb = karma.leaderboard();
  let board = await lb.top({ board: 'karma', period, limit: 50 });
  let fallback = false;
  if (!board.rows.length && period !== 'all') {
    board = await lb.top({ board: 'karma', period: 'all', limit: 50 });
    fallback = true;
  }
  return c.html(leaderboardPage({ board, period, fallback, earn: karma.howToEarn(), perCredit: karma.perCredit(), stats: await stats() }), 200, { 'cache-control': 'public, max-age=30' });
});
app.get('/leaderboard/u/:player', async (c) => {
  const player = c.req.param('player');
  // Hono includes the filename suffix in this segment parameter, so let the
  // package keep serving its public JSON representation from the same URL.
  if (player.endsWith('.json'))
    return (await karma.leaderboard().handle(c.req.raw)) ?? c.json({ error: 'not found' }, 404);
  const profile = await karma.leaderboard().profile(player);
  if (!profile) return c.html(notFoundPage({ stats: await stats() }), 404);
  return c.html(leaderboardProfilePage({ profile, stats: await stats() }), 200, { 'cache-control': 'public, max-age=30' });
});
app.get('/leaderboard.json', async (c) => (await karma.leaderboard().handle(c.req.raw)) ?? c.json({ error: 'not found' }, 404));
app.use('/leaderboard/*', async (c, next) => leaderboardMiddleware(karma.leaderboard())(c, next));

app.get('/pricing', async (c) => html(c, pricingPage({ stats: await stats(), net: networkStats() })));
app.get('/developers', async (c) => html(c, developersPage({ stats: await stats() })));

/* -------------------------------------------------- featured + newsletter -- */

app.get('/featured', async (c) => {
  const [featured, counts] = configured() ? await Promise.all([listApps({ featured: true, limit: 12 }), newsletter.subscriberCounts()]) : [{ apps: [] }, { active: 0 }];
  return html(
    c,
    featuredPage({
      stats: await stats(),
      net: networkStats(),
      featured: featured.apps,
      subscribers: counts.active,
      priceCents: newsletter.FEATURED.priceCents,
      days: newsletter.FEATURED.days,
    }),
  );
});

// Who featuring reaches: the store's own numbers, the CrawlProof network, the plans.
app.get('/advertise', async (c) => {
  const counts = configured() ? await newsletter.subscriberCounts() : { active: 0 };
  return html(
    c,
    advertisePage({
      stats: await stats(),
      net: networkStats(),
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

// The shell carries the shared profile fields as a <template> (user-profile.js)
// for the sign-up form and the contact panel.
const shell = (c) =>
  c.html(pub('console/index.html').toString().replace('</body>', `${profileTemplate()}\n</body>`), 200, { 'cache-control': 'no-cache' });
for (const p of ['/console', '/console/*', '/signin', '/signup', '/invites']) app.get(p, shell);

// An invite link. Remembered in a cookie (and then on the emailed sign-in link)
// until the person signs up; spent only by an account that sign-up creates.
app.get('/i/:code', async (c) => {
  const code = credits.canonicalInvite(c.req.param('code'));
  const state = code ? await credits.inviteState(code).catch(() => 'invalid') : 'invalid';
  const user = await auth.userFromSession(getCookie(c, config.session.cookie)).catch(() => null);
  if (state === 'ok' && !user)
    c.header('set-cookie', `${credits.INVITE_COOKIE}=${code}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${config.isProd ? '; Secure' : ''}`, { append: true });
  return c.html(invitePage({ code, state, signedIn: Boolean(user), days: credits.bonusDays() }), state === 'ok' ? 200 : 404, { 'cache-control': 'no-store' });
});

const asset = (file, type, cache = 'no-cache') => (c) => c.body(pub(file), 200, { 'content-type': type, 'cache-control': cache });
app.get('/assets/store.css', asset('store.css', 'text/css; charset=utf-8'));
app.get('/assets/store.js', asset('store.js', 'text/javascript; charset=utf-8'));
app.get('/assets/console.js', asset('console/console.js', 'text/javascript; charset=utf-8'));
app.get('/assets/console.css', asset('console/console.css', 'text/css; charset=utf-8'));
// The sign-up form's company-from-work-email helper (@profullstack/profile).
app.get('/assets/profile.js', (c) =>
  c.body(PROFILE_ENHANCE_SCRIPT, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' }),
);
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
  // The fields typed on the sign-up form, saved now that the account exists and the
  // link has proved the mailbox. A failure must not cost anybody their sign-in: the
  // console's contact panel asks again.
  if (s.profile)
    await saveSignupProfile(profiles, s.user.id, s.profile, { email: s.user.email }).catch((err) =>
      console.error(`[auth] signup profile save failed: ${err?.message ?? err}`),
    );
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  // A brand-new account takes the invite and ?ref= it came with: from the link
  // first (another device counts), else this browser's cookies.
  if (s.created) {
    const w = await credits.welcomeNewAccount(s.user, {
      invite: s.invite ?? getCookie(c, credits.INVITE_COOKIE),
      ref: s.ref ?? getCookie(c, credits.REF_COOKIE),
    });
    if (w.invite) console.log(`[invites] ${s.user.id}: ${w.invite.invite.ok ? `accepted, bonus ${w.invite.bonus}` : `refused ${w.invite.invite.reason}`}`);
  }
  c.header('set-cookie', `${credits.INVITE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
  // Back to where sign-in started (e.g. the CLI's consent page): same-site paths only.
  const next = decodeURIComponent(getCookie(c, 'pm_next') ?? '');
  if (next.startsWith('/') && !next.startsWith('//')) {
    c.header('set-cookie', 'pm_next=; Path=/; Max-Age=0; SameSite=Lax', { append: true });
    return c.redirect(next, 302);
  }
  return c.redirect('/console', 302);
});

app.post('/webhooks/coinpay', coinpayWebhook);

// OAuth 2.1 for the CLI, TUI and stdio MCP (shared house code: @profullstack/auth-system/oauth2).
mountOAuth(app);
// Sign in with CoinPay on the web (shared house code: @profullstack/stack/coinpay).
mountCoinPaySignin(app);

/* --------------------------------------------------------------------- API -- */

app.get('/api/v1', (c) => c.json({ name: 'pwamart', version: VERSION, docs: `${config.siteUrl}/llms.txt`, mcp: `${config.siteUrl}/mcp` }));
// The /advertise numbers as JSON: the store's own counts plus the CrawlProof network
// (null until the first refresh lands, or without the API token).
app.get('/api/v1/network', async (c) =>
  c.json(
    { store: await stats(), network: networkStats(), featured: { price_cents: newsletter.FEATURED.priceCents, days: newsletter.FEATURED.days, includes: ['home page', 'newsletter', 'crawlproof ad'] } },
    200,
    { 'cache-control': 'public, max-age=300' },
  ),
);
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
// The live embeddable badge (rating + installs; badge.js). One listing's, or by
// site for snippets shared across many sites (the Profullstack footer): a site
// with no listing gets "List your PWA free" and /for sends it to submit.
const SVG_HEADERS = (maxAge) => ({
  'content-type': 'image/svg+xml; charset=utf-8',
  'cache-control': `public, max-age=${maxAge}`,
  'access-control-allow-origin': '*',
  'cross-origin-resource-policy': 'cross-origin',
  'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
});
// Every page view on every site carrying the footer asks for /for.svg: remember lookups a minute.
const bySite = new Map();
async function cachedBySite(site) {
  const key = String(site ?? '').slice(0, 300);
  const hit = bySite.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.row;
  const row = configured() ? await appBySite(key).catch(() => null) : null;
  if (bySite.size > 5000) bySite.clear();
  bySite.set(key, { at: Date.now(), row });
  return row;
}
app.get('/for.svg', async (c) => {
  const row = await cachedBySite(c.req.query('site'));
  const t = badgeTheme(c.req.query('theme'));
  return row ? c.body(badgeSvg(row, t), 200, SVG_HEADERS(300)) : c.body(listBadgeSvg(t), 200, SVG_HEADERS(600));
});
app.get('/for', async (c) => {
  const row = await cachedBySite(c.req.query('site'));
  return c.redirect(row ? `/apps/${row.slug}?ref=badge` : '/console/submit?ref=badge', 302);
});
app.get('/apps/:slug/badge.svg', async (c) => {
  const row = configured() ? await appBadgeRow(c.req.param('slug')).catch(() => null) : null;
  if (!row) return c.body(listBadgeSvg(badgeTheme(c.req.query('theme'))), 404, SVG_HEADERS(60));
  return c.body(badgeSvg(row, badgeTheme(c.req.query('theme'))), 200, SVG_HEADERS(300));
});
app.get('/apps/:slug/icon-badge.svg', async (c) => {
  const row = configured() ? await appBadgeRow(c.req.param('slug')).catch(() => null) : null;
  if (!row) return c.body(listBadgeSvg(badgeTheme(c.req.query('theme'))), 404, SVG_HEADERS(60));
  const icon = await squareBadgeIconData(row);
  return c.body(squareIconBadgeSvg(row, icon, badgeTheme(c.req.query('theme'))), 200, SVG_HEADERS(300));
});
app.get('/publish', (c) => c.redirect('/console/submit', 302));
app.get('/install.sh', (c) => c.body(INSTALL_SH, 200, { 'content-type': 'text/x-shellscript' }));
// Aliases: the same script with its mode preset, so `curl … | sh` is all anyone types.
const withMode = (mode) => INSTALL_SH.replace(/^#!\/bin\/sh\n/, `#!/bin/sh\nPWAMART_MODE=\${PWAMART_MODE:-${mode}}\n`);
app.get('/upgrade.sh', (c) => c.body(withMode('upgrade'), 200, { 'content-type': 'text/x-shellscript' }));
app.get('/uninstall.sh', (c) => c.body(withMode('uninstall'), 200, { 'content-type': 'text/x-shellscript' }));
app.get('/.well-known/pwamart.txt', (c) => c.text('pwamart.com lists itself.\n'));
app.get('/.well-known/openwebring.json', (c) =>
  c.json({
    openwebring: '0.1',
    site: { url: 'https://pwamart.com/', name: 'pwamart' },
    made_by: 'both',
    rings: [{ ring: 'https://rssamplifier.com/ring/profullstack', slug: 'pwamart-com' }],
  }),
);
app.get('/robots.txt', (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /console\nDisallow: /api/\nSitemap: ${config.siteUrl}/sitemap.xml\n`),
);
/* ----------------------------------------------- feeds, releases, follows -- */

const xmlHeaders = { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=600' };

// New apps on the store, newest first.
app.get('/feed.xml', async (c) => {
  const list = configured() ? await listApps({ sort: 'new', limit: 50 }) : { apps: [] };
  return c.body(
    rss({
      title: 'pwamart: new web apps',
      link: `${config.siteUrl}/apps?sort=new`,
      self: `${config.siteUrl}/feed.xml`,
      description: 'New installable web apps (PWAs) on pwamart.',
      items: list.apps.map((a) => ({ title: `${a.name} by ${a.publisher.name}`, link: `${config.siteUrl}/apps/${a.slug}`, guid: `app:${a.slug}`, date: a.published_at ?? a.updated_at, category: a.category_name, description: a.summary ?? '' })),
    }),
    200,
    xmlHeaders,
  );
});

const releaseItems = (rows) =>
  rows.map((r) => ({
    title: r.kind === 'launched' ? `${r.name} is now on pwamart` : `${r.name}: ${r.title}${r.version ? ` (${r.version})` : ''}`,
    link: `${config.siteUrl}/apps/${r.slug}/releases#${r.id}`,
    guid: `release:${r.id}`,
    date: r.created_at,
    description: r.notes ?? '',
  }));

// Every release across the store.
app.get('/releases.xml', async (c) => {
  const rows = configured()
    ? await db()`select r.*, a.slug, a.name from app_releases r join apps a on a.id = r.app_id where a.status = 'published' and r.kind <> 'launched' order by r.created_at desc limit 50`
    : [];
  return c.body(rss({ title: 'pwamart: app updates', link: `${config.siteUrl}/releases`, self: `${config.siteUrl}/releases.xml`, description: 'What changed in the web apps on pwamart.', items: releaseItems(rows) }), 200, xmlHeaders);
});

app.get('/apps/:slug/releases.xml', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.text('no such app', 404);
  const rows = await db()`select r.*, ${row.slug} as slug, ${row.name} as name from app_releases r where r.app_id = ${row.id} order by r.created_at desc limit 50`;
  return c.body(rss({ title: `${row.name} on pwamart: releases`, link: `${config.siteUrl}/apps/${row.slug}/releases`, self: `${config.siteUrl}/apps/${row.slug}/releases.xml`, description: `What's new in ${row.name}.`, items: releaseItems(rows) }), 200, xmlHeaders);
});

// A publisher's new apps and releases together.
app.get('/publishers/:slug/feed.xml', async (c) => {
  const p = await getPublisher(c.req.param('slug'));
  if (!p) return c.text('no such publisher', 404);
  const rows = await db()`
    select r.*, a.slug, a.name from app_releases r join apps a on a.id = r.app_id join publishers pub on pub.id = a.publisher_id
    where pub.slug = ${p.slug} and a.status = 'published' order by r.created_at desc limit 50`;
  return c.body(rss({ title: `${p.name} on pwamart`, link: `${config.siteUrl}/publishers/${p.slug}`, self: `${config.siteUrl}/publishers/${p.slug}/feed.xml`, description: `New apps and updates from ${p.name}.`, items: releaseItems(rows) }), 200, xmlHeaders);
});

app.get('/apps/:slug/releases', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.html(notFoundPage({ stats: await stats() }), 404);
  const rows = await db()`select * from app_releases where app_id = ${row.id} order by created_at desc limit 100`;
  return html(c, releasesPage({ app: shape(row), releases: rows, stats: await stats() }));
});

const notice = (c, title, body, status = 200) =>
  c.html(layout({ title, noindex: true, body: `<div class="wrap"><section class="block" style="padding:70px 0;max-width:620px"><div class="eyebrow">pwamart</div><h1 style="margin:10px 0 14px;font-size:40px">${title}</h1><p class="lede">${body}</p><a class="btn" href="/">Back to the store</a></section></div>` }), status);

app.get('/follow/confirm', async (c) => {
  const [f] = await db()`update follows set confirmed_at = coalesce(confirmed_at, now()) where token = ${c.req.query('t') ?? ''} returning target_kind`;
  return f ? notice(c, 'You are following it now.', 'We will email you when there is something new. Every email has a one-click unsubscribe.') : notice(c, 'That link is not valid.', 'It may have been used to unsubscribe already.', 404);
});
app.get('/follow/unsubscribe', async (c) => {
  const [f] = await db()`delete from follows where token = ${c.req.query('t') ?? ''} returning id`;
  return f ? notice(c, 'Unsubscribed.', 'You will not hear about it again. You can follow it again from its page any time.') : notice(c, 'Already unsubscribed.', 'Nothing more will be sent for that link.');
});

// The push handlers for the service worker (classic build of @profullstack/notifications).
const PUSH_SW = [join(here, '..', 'node_modules'), join(root, 'node_modules')]
  .map((d) => join(d, '@profullstack/notifications/src/sw-classic.js'))
  .map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  })
  .find(Boolean);
const PUSH_CLIENT = [join(here, '..', 'node_modules'), join(root, 'node_modules')]
  .map((d) => join(d, '@profullstack/notifications/src/client.js'))
  .map((p) => {
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  })
  .find(Boolean);
app.get('/assets/push-client.js', (c) => (PUSH_CLIENT ? c.body(PUSH_CLIENT, 200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' }) : c.text('missing', 404)));
app.get('/assets/push-sw.js', (c) => (PUSH_SW ? c.body(PUSH_SW, 200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' }) : c.text('missing', 404)));

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
    u('/advertise'),
    u('/publishers'),
    u('/leaderboard'),
    u('/newsletter'),
    ...CATEGORIES.map(([k]) => u(`/apps?category=${k}`)),
    u('/apps?feature=offline'),
    u('/collections'),
    ...COLLECTIONS.map((x) => u(`/collections/${x.slug}`)),
    ...['cli', 'api', 'mcp', 'desktop'].map((k) => u(`/apps?surface=${k}`)),
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
- GET  /apps?q=&category=&publisher=&feature=offline&surface=cli|api|mcp|desktop&sort=top|new|rating|name&limit=&offset=   feature=offline: a service worker that answers from a cache
- GET  /apps/:slug                         details, publisher, reviews; app.surfaces = {pwa, cli, api, mcp, desktop} with install commands and downloads
- GET  /surfaces                           how many apps are a PWA (all), a CLI, an API, an MCP server, a desktop app
- GET  /collections, GET /collections/:slug   agentic workflow collections, each with one-command installs
- POST /apps/:slug/installs {method}       count an install (installs never earn karma)
- GET|POST|DELETE /apps/:slug/vote         upvote state / upvote (one per member) / take it back
- GET  /apps/:slug/comments                comments with replies (one level), author karma
- POST /apps/:slug/comments {body, parent?}   comment or reply (signed in; rate limited)
- DELETE /comments/:id                     your own (staff: any); its karma is taken back
- POST /apps/:slug/reviews {rating, body}  rate + review (30+ chars earns karma)
- POST /apps/:slug/share {network}         a share click: x|bluesky|linkedin|reddit|hn|mastodon|copy
- GET  /karma                              mine: total, week, rank, badges, credits, next free Featured week, history
- GET  /leaderboard?board=karma&period=week|month|all&limit=   public board (falls back to all time when a week is empty)
- GET  /categories, GET /plans, GET /publishers?q=&filter=all|claimed|imported|verified&sort=apps|name|new, GET /publishers/:slug
- GET  /me                                 your plan, usage, orgs and publishers
- POST /publishers {name, slug?, org?}
- POST /apps {publisher, url, category?, slug?}   inspect + create a draft
- POST /apps/:slug/verify | /refresh | /publish | /unlist | /unpublish
- PATCH /apps/:slug {name, summary, description, category, tags, project, surfaces}
  surfaces: {cli: {script|install, w3bs, commands}, api: {base, openapi, docs}, mcp: {url, stdio}, desktop: {page, downloads: [{label, url}]}}; a key set to false hides a detected surface, null returns it to detection
- POST /inspect {url}                      grade any URL's installability
- POST /orgs, /orgs/:org/invites, /orgs/:org/teams, /orgs/:org/projects   (Unlimited)
- POST /billing/checkout {plan: pro|unlimited}
- POST /credits/redeem {code}              redeem a credit code (PM-…) for Pro days; GET /credits lists them
- GET  /invites | POST /invites {note}     your invites (3, single use, new accounts) + open ?ref= link; both sides get Pro days
- POST /apps/:slug/feature {credit: true}  spend a karma credit: a free Featured week, no payment
- POST /apps/:slug/feature                 $19 CoinPay checkout: 7 days featured + the next newsletter issue + a free CrawlProof ad
- GET  /network                            store counts + 30-day CrawlProof network reach (what featuring buys)
- GET  /apps/:slug/featured                featured state, owed newsletter slot
- GET  /apps/:slug/badge                   the live badge (rating + installs): image URLs, HTML + Markdown snippets, backlink state
- GET  /badge?site=<homepage>              which listing a site is, and its badge (listed: false when none)
- POST /apps/:slug/badge/check             re-check the homepage for a link back now (owner); verified = ✓ + followed link
- POST /newsletter/subscribe {email}       double opt-in (public)

## Get featured
$19, paid once in any major coin or PayPal: ${config.siteUrl}/featured. Includes a free ad across the CrawlProof network
for the same week; reach: ${config.siteUrl}/advertise. Newsletter: ${config.siteUrl}/newsletter

## Karma (${config.siteUrl}/leaderboard)
Signed-in members earn karma; anonymous actions work and earn nothing. Same points as built.indie:
${karma.howToEarn().map((r) => `- +${r.points} ${r.label}: ${r.rule}`).join('\n')}
Self-dealing (your own org's apps) and staff accounts earn nothing. Every ${karma.perCredit()} karma grants a free
Featured week credit: POST /api/v1/apps/:slug/feature {"credit": true}. Board JSON: ${config.siteUrl}/leaderboard/karma.json?period=week,
RSS: ${config.siteUrl}/leaderboard/karma.xml, a member card: ${config.siteUrl}/leaderboard/u/<player>.

## Surfaces: PWA, CLI, API, MCP, Desktop
Every listing is a PWA. The store also finds, on the app's own origin: a CLI (a shell
installer at /install.sh, or its entry in the w3bs catalog at https://w3bs.org/packages),
an MCP server (answers initialize at /mcp, /api/mcp or a URL in its llms.txt), an API
(/openapi.json, /api/v1/health or /api/ paths in llms.txt) and a desktop app (list lines
"- Platform: https://..." under a llms.txt heading with "Desktop" in it, on the app's host
or its GitHub releases; else .dmg/.exe/.msi/.AppImage/.deb/.rpm links). Re-checked weekly
and on POST /apps/:slug/refresh. Filter with ?surface=cli|api|mcp|desktop.

## Collections (${config.siteUrl}/collections)
Apps grouped by agentic workflow. Each installs in one command:
- curl -fsSL ${config.siteUrl}/collections/<slug>/install.sh | sh     every member's own CLI installer (?apps=a,b for some)
- ${config.siteUrl}/collections/<slug>/mcp.json                        every member's MCP server as an mcpServers config
Collections: ${COLLECTIONS.map((x) => x.slug).join(', ')}

## Badge
- ${config.siteUrl}/apps/<slug>/badge.svg?theme=light|dark      live rating + installs
- ${config.siteUrl}/for.svg?site=<homepage> linking ${config.siteUrl}/for?site=<homepage>   one snippet for any site; unlisted = "List your PWA free"
A homepage that links back earns the listing the ✓ and a followed link (re-checked daily).

## MCP
- Hosted: POST ${config.siteUrl}/mcp (JSON-RPC, streamable HTTP)
- stdio: npx -y @profullstack/pwamart-mcp   (PWAMART_API_KEY for publishing tools)
Tools: search_apps (surface=cli|api|mcp|desktop, sort=votes), get_app, list_categories, list_collections, get_collection, install_app, submit_app, verify_app, publish_app, get_badge, check_badge, feature_app (credit=true), upvote_app, review_app, comment, list_comments, my_karma, leaderboard

## CLI + TUI
- curl -fsSL ${config.siteUrl}/install.sh | sh    (or npm i -g @profullstack/pwamart)
- pwamart search <q> [--surface cli|api|mcp|desktop] | info <slug> | install <slug> | tui | submit <url> | verify <slug> | publish <slug>
- pwamart collections [slug]   agentic workflow collections and their one-command installs
- pwamart badge <slug> [--check] [--light] | pwamart badge --site <homepage>   badge snippets, backlink check
- pwamart karma | leaderboard [--period week|month|all] | vote <slug> [--remove] | review <slug> --rating 5 --text "…" | comment <slug> "text" [--reply id] | comments <slug> | feature <slug> --credit
- pwamart login (OAuth 2.1, browser; --manual over SSH) | logout | whoami | upgrade | uninstall
- curl -fsSL ${config.siteUrl}/upgrade.sh | sh ; curl -fsSL ${config.siteUrl}/uninstall.sh | sh

## OAuth 2.1 (for the CLI, TUI and MCP; shared code: @profullstack/auth-system/oauth2)
- Discovery: ${config.siteUrl}/.well-known/oauth-authorization-server
- Public client pwamart-cli; authorization code + PKCE S256; loopback redirect http://127.0.0.1:<port>/callback
- Access tokens pm_at_… (1h) work anywhere an API key does; refresh tokens rotate, reuse revokes the sign-in

## iOS
- One app: ${config.siteUrl}/apps/<slug>/install.mobileconfig
- A bundle: ${config.siteUrl}/bundle.mobileconfig?apps=a,b,c
`),
);
