/**
 * The Adult (18+) category: a listing is adult when its category is `adult`, an
 * anonymous reader never sees one on any surface, and a signed-in member sees
 * them only inside the category. Against a real Postgres (DATABASE_URL), like
 * api.test.js; this file adds to the schema instead of recreating it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const run = randomBytes(4).toString('hex');
const NAME = `Velvet${run}`; // the adult listing every public surface is searched for
const PLAIN = `Plainsite${run}`; // adult too, and not an installable PWA
const MINE = `Members${run}`; // submitted by a member
const SIGNIN_MESSAGE = 'The Adult (18+) category needs a signed-in account';

function pwaServer({ manifest = true } = {}) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const [, name, file] = u.pathname.split('/');
      if (file === 'manifest.json')
        return Response.json({
          name,
          short_name: name,
          start_url: `/${name}/?pwa`,
          display: 'standalone',
          description: `The ${name} app.`,
          icons: [
            { src: `/${name}/i192.png`, sizes: '192x192', type: 'image/png' },
            { src: `/${name}/i512.png`, sizes: '512x512', type: 'image/png' },
          ],
        });
      if (file?.endsWith('.png')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { headers: { 'content-type': 'image/png' } });
      if (file === 'sw.js') return new Response('not found', { status: 404 });
      return new Response(
        `<!doctype html><html><head><title>${name || 'home'}</title>${manifest ? `<link rel="manifest" href="/${name}/manifest.json">` : ''}
        <meta name="description" content="site meta description"></head><body>hello</body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    },
  });
}

d('adult category', () => {
  let app, auth, db, sql, inspectMod, config;
  let pwa, plain, third;
  let staff, member, other;
  let cookie;
  const slugs = {};

  const req = (key) => async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
  };
  const anon = req(null);
  const page = async (path, headers = {}) => {
    const res = await app.request(path, { headers });
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  const mcp = async (name, args, key) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return JSON.stringify(await res.json());
  };
  async function account(name, { admin = false } = {}) {
    const user = await auth.findOrCreateUser(`${name}-${run}@example.test`);
    if (admin) await sql`update users set is_admin = true where id = ${user.id}`;
    const { key } = await auth.createApiKey({ userId: user.id });
    return { user, key, call: req(key) };
  }

  beforeAll(async () => {
    process.env.SITE_URL = 'http://localhost:3999';
    process.env.ADMIN_EMAILS = 'staff@example.test';
    const dbm = await import('../packages/db/src/index.js');
    db = dbm.db;
    sql = db();
    await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
    config = (await import('../apps/web/src/config.js')).config;
    inspectMod = await import('../apps/web/src/inspect.js');
    inspectMod.setAllowLocal(true);
    app = (await import('../apps/web/src/app.js')).app;
    auth = await import('../apps/web/src/auth.js');
    pwa = pwaServer();
    plain = pwaServer({ manifest: false });
    third = pwaServer();
    staff = await account('staff', { admin: true });
    member = await account('member');
    other = await account('other');
    cookie = `${config.session.cookie}=${await auth.startSessionFor(member.user.id, 'test')}`;
  });

  afterAll(async () => {
    for (const s of [pwa, plain, third]) s?.stop(true);
    inspectMod?.setAllowLocal(false);
  });

  /* ------------------------------------------------------------ seeding -- */

  test('staff bulk-list adult sites, installable or not; nobody else can', async () => {
    const items = [
      { name: NAME, url: `http://localhost:${pwa.port}/velvet/`, description: 'A studio site for adults. Second sentence.', tags: ['VR', '4K'] },
      { name: PLAIN, url: `http://localhost:${plain.port}/plain/`, description: 'No manifest here.', tags: ['niche'] },
    ];
    expect((await anon('POST', '/admin/listings', { category: 'adult', items })).status).toBe(401);
    expect((await member.call('POST', '/admin/listings', { category: 'adult', items })).status).toBe(404);
    expect((await staff.call('POST', '/admin/listings', { category: 'nope', items })).status).toBe(400);
    expect((await staff.call('POST', '/admin/listings', { category: 'adult', items: [] })).status).toBe(400);

    const r = await staff.call('POST', '/admin/listings', { category: 'adult', items: [...items, { name: 'Bad', url: 'not a url' }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ category: 'adult', published: 2, skipped: 1, errors: 0 });
    const [a, b] = r.body.results;
    expect(a).toMatchObject({ result: 'published', inspected: true, installable: true });
    expect(b).toMatchObject({ result: 'published', inspected: true, installable: false });
    slugs.velvet = a.slug;
    slugs.plain = b.slug;

    const [row] = await sql`select a.category, a.status, a.verified_by, a.name, a.summary, a.tags, a.source, p.claimable, p.claim_domain
                           from apps a join publishers p on p.id = a.publisher_id where a.slug = ${a.slug}`;
    // The seed's own name and description win over what the site says about itself.
    expect(row).toMatchObject({ category: 'adult', status: 'published', verified_by: 'staff', name: NAME, summary: 'A studio site for adults.', source: 'staff', claimable: true, claim_domain: 'localhost' });
    expect(row.tags).toEqual(['vr', '4k']);

    // Running it again changes nothing: an origin already listed is reported, not duplicated.
    const again = await staff.call('POST', '/admin/listings', { category: 'adult', items });
    expect(again.body).toMatchObject({ published: 0, exists: 2 });
    expect(again.body.results[0].slug).toBe(a.slug);
  });

  test('a site the inspector cannot read at all is still listed, and says so', async () => {
    const { staffListing } = await import('../apps/web/src/imports.js');
    const r = await staffListing(
      { name: `Walled${run}`, url: `https://walled-${run}.example/`, description: 'Refuses server fetches.', tags: [] },
      { category: 'adult', inspectFn: async () => Promise.reject(new Error('answered HTTP 403')) },
    );
    expect(r).toMatchObject({ result: 'published', inspected: false, installable: false });
    expect(r.detail).toContain('HTTP 403');
    slugs.walled = r.slug;
    const [row] = await sql`select category, status, origin, check_report from apps where slug = ${r.slug}`;
    expect(row).toMatchObject({ category: 'adult', status: 'published', origin: `https://walled-${run}.example` });
    expect(row.check_report.installable).toBe(false);
  });

  /* ---------------------------------------------------------- anonymous -- */

  test('anonymous: no list, search, feed, sitemap, llms.txt or collection names an adult listing', async () => {
    // Releases exist for them too (the "launched" entry), so the release feeds are a real test.
    await (await import('../apps/web/src/releases.js')).backfillLaunches();
    const paths = [
      '/',
      '/apps',
      '/apps?sort=new',
      `/apps?q=${NAME}`,
      `/apps?q=${PLAIN}`,
      '/apps?surface=api',
      '/featured',
      '/publishers',
      `/publishers?q=localhost`,
      '/collections',
      '/collections/apis',
      '/collections/apis/mcp.json',
      '/collections/clis/install.sh',
      '/feed.xml',
      '/releases.xml',
      '/sitemap.xml',
      '/llms.txt',
      '/leaderboard',
      '/api/v1/apps',
      '/api/v1/apps?sort=new&limit=100',
      `/api/v1/apps?q=${NAME}`,
      '/api/v1/apps?featured=1',
      '/api/v1/categories',
      '/api/v1/publishers?limit=100',
      '/api/v1/publishers?q=localhost',
      '/api/v1/releases?limit=100',
      '/api/v1/collections',
      '/api/v1/network',
    ];
    for (const path of paths) {
      const r = await page(path);
      // A search page echoes the query it was given, so there only the slugs (the links) count.
      const needles = path.includes('q=') ? [slugs.velvet, slugs.plain, slugs.walled] : [NAME, PLAIN, slugs.velvet, slugs.plain, slugs.walled];
      for (const needle of needles) expect(`${path}: ${r.text.includes(needle)}`).toBe(`${path}: false`);
    }
    // The category itself is not advertised either.
    expect((await page('/')).text).not.toContain('Adult (18+)');
    expect((await page('/apps')).text).not.toContain('category=adult');
    expect((await page('/sitemap.xml')).text).not.toContain('adult');
    expect((await anon('GET', '/categories')).body.categories.some((c) => c.slug === 'adult')).toBe(false);
  });

  test('anonymous: adult listings are not counted', async () => {
    const [{ n }] = await sql`select count(*)::int as n from apps where status = 'published' and category <> 'adult'`;
    const all = await anon('GET', '/apps?limit=1');
    expect(all.body.total).toBe(n);
    const cats = (await anon('GET', '/categories')).body.categories.reduce((s, c) => s + c.apps, 0);
    expect(cats).toBe(n);
    expect((await anon('GET', '/surfaces')).body.surfaces.find((s) => s.key === 'pwa').apps).toBe(n);
  });

  test('anonymous: the listing page and the category page send you to sign in, never a 404', async () => {
    const listing = await page(`/apps/${slugs.velvet}`);
    expect(listing.status).toBe(302);
    expect(listing.headers.get('location')).toBe(`/signin?next=${encodeURIComponent(`/apps/${slugs.velvet}`)}`);
    expect(listing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(listing.headers.get('cache-control')).toBe('no-store');
    expect(listing.text).not.toContain(NAME);

    const cat = await page('/apps?category=adult');
    expect(cat.status).toBe(302);
    expect(cat.headers.get('location')).toBe(`/signin?next=${encodeURIComponent('/apps?category=adult')}`);

    for (const sub of ['releases', 'releases.xml', 'install.mobileconfig']) {
      const r = await page(`/apps/${slugs.velvet}/${sub}`);
      expect(`${sub} ${r.status}`).toBe(`${sub} 302`);
      expect(r.headers.get('location')).toContain('/signin?next=');
    }
    // A bundle never carries one for an anonymous reader.
    expect((await page(`/bundle.mobileconfig?apps=${slugs.velvet}`)).status).toBe(400);
    // Its unclaimed publisher has only adult listings, so it is gated the same way.
    const [{ slug: pub }] = await sql`select p.slug from publishers p join apps a on a.publisher_id = p.id where a.slug = ${slugs.walled}`;
    slugs.pub = pub;
    expect((await page(`/publishers/${pub}`)).status).toBe(302);
    expect((await page(`/apps?publisher=${pub}`)).text).not.toContain(`Walled${run}`);
    expect((await page(`/publishers/${pub}/feed.xml`)).status).toBe(401);
    expect((await anon('GET', `/publishers/${pub}`)).status).toBe(401);
  });

  test('anonymous: every JSON route about an adult listing answers 401 with the reason', async () => {
    const routes = [
      ['GET', `/apps/${slugs.velvet}`],
      ['GET', '/apps?category=adult'],
      ['GET', `/apps?category=adult&q=${NAME}`],
      ['GET', `/apps/${slugs.velvet}/reviews`],
      ['GET', `/apps/${slugs.velvet}/comments`],
      ['GET', `/apps/${slugs.velvet}/releases`],
      ['GET', `/apps/${slugs.velvet}/badge`],
      ['GET', `/apps/${slugs.velvet}/vote`],
      ['POST', `/apps/${slugs.velvet}/installs`, { method: 'web' }],
      ['POST', `/apps/${slugs.velvet}/share`, { network: 'x' }],
      ['GET', `/badge?site=${encodeURIComponent(`http://localhost:${pwa.port}/`)}`],
      ['GET', `/follow/state?kind=app&slug=${slugs.velvet}`],
      ['POST', '/follow', { kind: 'app', slug: slugs.velvet, email: `reader-${run}@example.test` }],
      ['POST', '/follow', { kind: 'publisher', slug: slugs.pub, email: `reader-${run}@example.test` }],
    ];
    for (const [method, path, body] of routes) {
      const r = await anon(method, path, body);
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 401`);
      expect(r.body.error).toContain(SIGNIN_MESSAGE);
      expect(JSON.stringify(r.body)).not.toContain(NAME);
    }
    // A wrong key is anonymous too.
    expect((await req('pm_live_nope')('GET', `/apps/${slugs.velvet}`)).status).toBe(401);
  });

  test('anonymous: the hosted MCP tools cannot reach one', async () => {
    expect(await mcp('search_apps', { query: NAME })).not.toContain(slugs.velvet);
    expect(await mcp('list_categories', {})).not.toContain('adult');
    for (const out of [await mcp('search_apps', { category: 'adult' }), await mcp('get_app', { slug: slugs.velvet }), await mcp('install_app', { slug: slugs.velvet })]) {
      expect(out).toContain(SIGNIN_MESSAGE);
      expect(out).not.toContain(NAME);
    }
  });

  test('the badge image keeps working for an adult listing; its link goes to sign-in', async () => {
    const svg = await page(`/apps/${slugs.velvet}/badge.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    const site = encodeURIComponent(`http://localhost:${pwa.port}/`);
    expect((await page(`/for.svg?site=${site}`)).status).toBe(200);
    const hop = await page(`/for?site=${site}`);
    expect(hop.status).toBe(302);
    expect(hop.headers.get('location')).toBe(`/apps/${slugs.velvet}?ref=badge`);
    const gate = await page(hop.headers.get('location'));
    expect(gate.status).toBe(302);
    expect(gate.headers.get('location')).toBe(`/signin?next=${encodeURIComponent(`/apps/${slugs.velvet}?ref=badge`)}`);
  });

  /* ------------------------------------------------------------- members -- */

  test('a signed-in member opens the category and a listing; both are noindex and never cached', async () => {
    const cat = await page('/apps?category=adult', { cookie });
    expect(cat.status).toBe(200);
    expect(cat.text).toContain(NAME);
    expect(cat.text).toContain(PLAIN);
    expect(cat.text).toContain('Adult (18+)');
    expect(cat.text).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(cat.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(cat.headers.get('cache-control')).toBe('private, no-store');
    // The one-line notice, the first time in a session only.
    expect(cat.text).toContain('Adult content. You must be 18 or older.');
    expect(cat.headers.get('set-cookie')).toContain('pm_adult=1');
    const second = await page('/apps?category=adult', { cookie: `${cookie}; pm_adult=1` });
    expect(second.text).not.toContain('You must be 18 or older');

    const listing = await page(`/apps/${slugs.velvet}`, { cookie: `${cookie}; pm_adult=1` });
    expect(listing.status).toBe(200);
    expect(listing.text).toContain(NAME);
    expect(listing.text).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(listing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(listing.headers.get('cache-control')).toBe('private, no-store');
    // "More in Adult (18+)" stays inside the category.
    expect(listing.text).toContain(PLAIN);
    // One that is not an installable PWA renders too.
    expect((await page(`/apps/${slugs.walled}`, { cookie })).status).toBe(200);

    const pub = await page(`/publishers/${slugs.pub}`, { cookie });
    expect(pub.status).toBe(200);
    expect(pub.text).toContain(`Walled${run}`);
    expect(pub.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  test('a member sees the Adult entry where categories are listed, but no adult listing outside the category', async () => {
    const home = await page('/', { cookie });
    expect(home.text).toContain('Adult (18+)');
    expect(home.text).toContain('/apps?category=adult');
    expect(home.headers.get('cache-control')).toBe('private, no-store');
    for (const path of ['/', '/apps', '/apps?sort=new', `/apps?q=${NAME}`, '/featured', '/feed.xml', '/sitemap.xml', '/publishers']) {
      const r = await page(path, { cookie });
      expect(`${path}: ${r.text.includes(`/apps/${slugs.velvet}`)}`).toBe(`${path}: false`);
    }
    // Search inside the category finds it.
    const found = await page(`/apps?category=adult&q=${NAME}`, { cookie });
    expect(found.text).toContain(`/apps/${slugs.velvet}`);
    expect(found.text).not.toContain(PLAIN);
  });

  test('an account key lists adult listings only with an explicit category=adult', async () => {
    const cats = await member.call('GET', '/categories');
    const entry = cats.body.categories.find((c) => c.slug === 'adult');
    expect(entry).toMatchObject({ name: 'Adult (18+)', signed_in_only: true });
    expect(entry.apps).toBeGreaterThanOrEqual(3);

    const inside = await member.call('GET', `/apps?category=adult&q=${NAME}`);
    expect(inside.status).toBe(200);
    expect(inside.body.apps.map((a) => a.slug)).toEqual([slugs.velvet]);
    expect(inside.body.apps[0]).toMatchObject({ category: 'adult', category_name: 'Adult (18+)' });
    expect(inside.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    // Without it, a member gets exactly what an anonymous caller gets.
    expect((await member.call('GET', `/apps?q=${NAME}`)).body.total).toBe(0);
    expect((await member.call('GET', '/apps?limit=1')).body.total).toBe((await anon('GET', '/apps?limit=1')).body.total);

    const one = await member.call('GET', `/apps/${slugs.velvet}`);
    expect(one.status).toBe(200);
    expect(one.body.app.name).toBe(NAME);
    expect(one.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((await member.call('GET', `/publishers/${slugs.pub}`)).body.apps.map((a) => a.slug)).toEqual([slugs.walled]);
    expect((await member.call('GET', `/badge?site=${encodeURIComponent(`http://localhost:${pwa.port}/`)}`)).body.listed).toBe(true);

    expect(await mcp('search_apps', { category: 'adult', query: NAME }, member.key)).toContain(slugs.velvet);
    expect(await mcp('search_apps', { query: NAME }, member.key)).not.toContain(slugs.velvet);
    expect(await mcp('get_app', { slug: slugs.velvet }, member.key)).toContain(NAME);
    expect(await mcp('list_categories', {}, member.key)).toContain('Adult (18+)');
  });

  /* ---------------------------------------------------------- submitting -- */

  test('a signed-in submitter can pick the Adult category; an anonymous one is told to sign in', async () => {
    const no = await anon('POST', '/apps', { publisher: 'x', url: `http://localhost:${third.port}/mine/`, category: 'adult' });
    expect(no.status).toBe(401);
    expect(no.body.error).toContain('sign in');

    const p = await member.call('POST', '/publishers', { name: `Member Pub ${run}` });
    expect(p.status).toBe(201);
    slugs.memberPub = p.body.publisher.slug;
    const r = await member.call('POST', '/apps', { publisher: slugs.memberPub, url: `http://localhost:${third.port}/mine/`, category: 'adult', name: MINE, slug: `mine-${run}` });
    expect(r.status).toBe(201);
    expect(r.body.app).toMatchObject({ category: 'adult', category_name: 'Adult (18+)', status: 'draft' });
    slugs.mine = r.body.app.slug;
    // A draft is as hidden as a published one.
    expect((await anon('GET', `/apps/${slugs.mine}`)).status).toBe(401);
    expect((await page(`/apps/${slugs.mine}`)).status).toBe(302);
  });

  test('staff move a listing in and out of the category; an adult listing cannot be featured', async () => {
    expect((await member.call('POST', `/admin/apps/${slugs.mine}`, { category: 'productivity' })).status).toBe(404);
    expect((await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'nope' })).status).toBe(400);

    const out = await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'productivity', verified: true, status: 'published' });
    expect(out.body.app).toMatchObject({ category: 'productivity', status: 'published' });
    expect((await anon('GET', `/apps/${slugs.mine}`)).status).toBe(200);
    expect((await anon('GET', `/apps?q=${MINE}`)).body.apps.map((a) => a.slug)).toEqual([slugs.mine]);
    expect((await page('/sitemap.xml')).text).toContain(`/apps/${slugs.mine}<`);
    expect((await page(`/publishers/${slugs.memberPub}`)).status).toBe(200);

    const back = await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'adult' });
    expect(back.body.app.category).toBe('adult');
    expect((await anon('GET', `/apps/${slugs.mine}`)).status).toBe(401);
    expect((await anon('GET', `/apps?q=${MINE}`)).body.total).toBe(0);
    expect((await page('/sitemap.xml')).text).not.toContain(slugs.mine);
    expect((await page(`/publishers/${slugs.memberPub}`)).status).toBe(302);

    const f = await member.call('POST', `/apps/${slugs.mine}/feature`, { credit: true });
    expect(f.status).toBe(409);
    expect(f.body.error).toContain('cannot be featured');
    // The owner can still move it out themselves.
    expect((await member.call('PATCH', `/apps/${slugs.mine}`, { category: 'adult' })).body.app.category).toBe('adult');
  });

  /* ------------------------------------------------- mail, ads, followers -- */

  test('no CrawlProof campaign is made for an adult listing; one that had a campaign is paused, then resumed', async () => {
    const { runListingAds } = await import('../apps/web/src/daemon.js');
    const made = [];
    const createCampaign = async ({ url }) => {
      made.push(url);
      return { id: `ad-${run}-${made.length}`, ref: null };
    };
    const set = [];
    const setStatus = async (id, status) => set.push([id, status]);
    for (let i = 0; i < 100; i++) if (!(await runListingAds({ batch: 50, createCampaign, setStatus })).due) break;
    for (const s of [slugs.velvet, slugs.plain, slugs.walled, slugs.mine]) expect(made.some((u) => u.endsWith(`/apps/${s}`))).toBe(false);
    const adult = await sql`select count(*)::int as n from apps where category = 'adult' and listing_ad_id is not null and slug = any(${Object.values(slugs)}::text[])`;
    expect(adult[0].n).toBe(0);
    expect(set).toEqual([]);

    // Listed publicly, it gets its campaign like any listing...
    await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'productivity' });
    for (let i = 0; i < 100; i++) if (!(await runListingAds({ batch: 50, createCampaign, setStatus })).due) break;
    const [{ listing_ad_id: adId }] = await sql`select listing_ad_id from apps where slug = ${slugs.mine}`;
    expect(adId).toMatch(/^ad-/);
    // ...moved into the category, the campaign is paused (once)...
    await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'adult' });
    expect((await runListingAds({ createCampaign, setStatus })).paused).toBe(1);
    expect((await runListingAds({ createCampaign, setStatus })).paused).toBe(0);
    expect(set).toEqual([[adId, 'paused']]);
    // ...and moved back out, resumed.
    await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'productivity' });
    expect((await runListingAds({ createCampaign, setStatus })).resumed).toBe(1);
    expect(set).toEqual([[adId, 'paused'], [adId, 'active']]);
    await staff.call('POST', `/admin/apps/${slugs.mine}`, { category: 'adult' });
    await runListingAds({ createCampaign, setStatus });

    // A featured slot on an adult listing never starts a featured campaign either.
    const { syncFeaturedAds } = await import('../apps/web/src/newsletter.js');
    const [{ id: appId }] = await sql`select id from apps where slug = ${slugs.velvet}`;
    const [pay] = await sql`insert into payments (user_id, provider, provider_ref, amount_cents, status) values (${staff.user.id}, 'grant', ${`adult-${run}`}, 0, 'paid') returning id`;
    await sql`insert into featured_slots (payment_id, app_id, user_id, starts_at, ends_at) values (${pay.id}, ${appId}, ${staff.user.id}, now(), now() + interval '7 days')`;
    const started = [];
    await syncFeaturedAds({ ads: { mock: true, createCampaign: async (x) => (started.push(x.url), { id: `f-${run}` }), setCampaignStatus: async () => {} }, perTurn: 50 });
    expect(started.some((u) => u.endsWith(`/apps/${slugs.velvet}`))).toBe(false);
  });

  test('the newsletter draft leaves adult listings out, new or owed a slot', async () => {
    const { draftIssue } = await import('../apps/web/src/newsletter.js');
    const issue = await draftIssue({ userId: staff.user.id, subject: `adult test ${run}` });
    for (const needle of [NAME, PLAIN, `Walled${run}`, MINE, slugs.velvet]) expect(issue.body).not.toContain(needle);
    await sql`delete from newsletter_issues where id = ${issue.id}`;
  });

  test('the weekly outreach digest never mentions an adult listing', async () => {
    const o = await import('../apps/web/src/outreach.js');
    // An unclaimed adult publisher with a contact address gets no claim reminder.
    await sql`update publishers set contact_email = ${`owner-${run}@adult.example`} where slug = ${slugs.pub}`;
    const claim = await o.claimTargets(sql);
    expect(claim.has(`owner-${run}@adult.example`)).toBe(false);
    const owners = JSON.stringify([...(await o.ownerTargets(sql)).entries()]);
    expect(owners).not.toContain(slugs.mine);
    expect(owners).not.toContain(MINE);
  });

  test('release news about an adult listing reaches only members who follow that listing', async () => {
    const { queueDeliveries } = await import('../apps/web/src/releases.js');
    const [a] = await sql`select id, publisher_id from apps where slug = ${slugs.velvet}`;
    const tok = () => randomBytes(8).toString('hex');
    const [byPublisher] = await sql`insert into follows (target_kind, target_id, user_id, token, confirmed_at) values ('publisher', ${a.publisher_id}, ${other.user.id}, ${tok()}, now()) returning id`;
    const [byEmail] = await sql`insert into follows (target_kind, target_id, email, token, confirmed_at) values ('app', ${a.id}, ${`reader-${run}@example.test`}, ${tok()}, now()) returning id`;
    const [byMember] = await sql`insert into follows (target_kind, target_id, user_id, token, confirmed_at) values ('app', ${a.id}, ${member.user.id}, ${tok()}, now()) returning id`;
    const [rel] = await sql`insert into app_releases (app_id, kind, title) values (${a.id}, 'publisher', 'Something new') returning id`;
    for (let i = 0; i < 20; i++) if (!(await queueDeliveries())) break;
    const got = (await sql`select follow_id from release_deliveries where release_id = ${rel.id}`).map((r) => r.follow_id);
    expect(got).toEqual([byMember.id]);
    expect(got).not.toContain(byPublisher.id);
    expect(got).not.toContain(byEmail.id);
    // Nothing is left queued for the mailer to pick up in a later test file.
    await sql`delete from release_deliveries where release_id = ${rel.id}`;
    await sql`delete from follows where id = any(${[byPublisher.id, byEmail.id, byMember.id]}::uuid[])`;
  });
});
