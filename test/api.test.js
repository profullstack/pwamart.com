/**
 * End to end against a real Postgres: DATABASE_URL=postgres://... bun test
 * A fixture PWA is served locally and the inspector is allowed to fetch it.
 * Without DATABASE_URL these tests are skipped (the unit tests still run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

let app, auth, db, close, inspectMod, fixture, base;
const token = { value: '' };
const fixtureApps = new Map();

function fixturePage(name, { manifest = true } = {}) {
  return `<!doctype html><html><head><title>${name}</title>
  ${manifest ? `<link rel="manifest" href="/${name}/manifest.json">` : ''}
  <meta name="description" content="${name} does things">
  <meta name="theme-color" content="#123456">
  <script>navigator.serviceWorker.register('/sw.js')</script></head><body>${name}</body></html>`;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SITE_URL = 'http://localhost:3999';
  process.env.ADMIN_EMAILS = 'staff@example.test';
  process.env.COINPAY_API_KEY = 'test';
  process.env.COINPAY_BUSINESS_ID = 'biz';
  process.env.COINPAY_WEBHOOK_SECRET = 'whsec_test';
  const dbm = await import('../packages/db/src/index.js');
  db = dbm.db;
  close = dbm.close;
  const sql = db();
  await sql.unsafe('drop schema public cascade; create schema public;');
  await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
  const { configurePayments } = await import('../packages/payments/src/index.js');
  const { config } = await import('../apps/web/src/config.js');
  configurePayments({ sql, coinpay: config.coinpay, siteUrl: config.siteUrl });
  inspectMod = await import('../apps/web/src/inspect.js');
  inspectMod.setAllowLocal(true);
  app = (await import('../apps/web/src/app.js')).app;
  auth = await import('../apps/web/src/auth.js');

  fixture = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === '/.well-known/pwamart.txt') return new Response(token.value);
      const [, name, file] = u.pathname.split('/');
      if (!name) return new Response('root');
      if (name === 'broken') return new Response(fixturePage(name, { manifest: false }), { headers: { 'content-type': 'text/html' } });
      if (file === 'manifest.json')
        return Response.json({
          name: name,
          short_name: name,
          start_url: `/${name}/?pwa`,
          display: 'standalone',
          description: `The ${name} app.`,
          categories: ['productivity'],
          icons: [
            { src: `/${name}/i192.png`, sizes: '192x192', type: 'image/png' },
            { src: `/${name}/i512.png`, sizes: '512x512', type: 'image/png' },
          ],
        });
      if (file?.endsWith('.png')) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { headers: { 'content-type': 'image/png' } });
      fixtureApps.set(name, true);
      return new Response(fixturePage(name), { headers: { 'content-type': 'text/html' } });
    },
  });
  base = `http://localhost:${fixture.port}`;
});

afterAll(async () => {
  fixture?.stop(true);
  inspectMod?.setAllowLocal(false);
  await close?.();
});

async function keyFor(email) {
  const user = await auth.findOrCreateUser(email);
  const { key } = await auth.createApiKey({ userId: user.id });
  return { user, key };
}
const req = (key) => async (method, path, body) => {
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

d('store end to end', () => {
  let alice, call, anon;

  test('health answers with the database up', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    expect((await res.json()).database).toBe('ok');
  });

  test('a signed-in account is on the free plan with a personal org', async () => {
    alice = await keyFor('alice@example.test');
    call = req(alice.key);
    anon = req(null);
    const r = await call('GET', '/me');
    expect(r.status).toBe(200);
    expect(r.body.plan.key).toBe('free');
    expect(r.body.plan.publishers).toBe(1);
    expect(r.body.plan.apps).toBe(10);
    expect(r.body.orgs.some((o) => o.personal)).toBe(true);
    expect((await anon('GET', '/me')).status).toBe(401);
  });

  test('the free plan allows exactly one publisher', async () => {
    const a = await call('POST', '/publishers', { name: 'Alice Apps' });
    expect(a.status).toBe(201);
    expect(a.body.publisher.slug).toBe('alice-apps');
    const b = await call('POST', '/publishers', { name: 'Second' });
    expect(b.status).toBe(402);
    expect(b.body.error).toContain('Pro');
  });

  test('inspect grades a fixture PWA and refuses a page with no manifest', async () => {
    const ok = await call('POST', '/inspect', { url: `${base}/notes/` });
    expect(ok.status).toBe(200);
    expect(ok.body.installable).toBe(true);
    expect(ok.body.app.name).toBe('notes');
    const bad = await call('POST', '/inspect', { url: `${base}/broken/` });
    expect(bad.body.installable).toBe(false);
    expect(bad.body.checks.find((c) => c.id === 'manifest').ok).toBe(false);
  });

  test('submit -> draft; publish refuses until the origin is verified', async () => {
    const s = await call('POST', '/apps', { url: `${base}/notes/`, publisher: 'alice-apps' });
    expect(s.status).toBe(201);
    expect(s.body.app.slug).toBe('notes');
    expect(s.body.app.status).toBe('draft');
    expect(s.body.verify.verified).toBe(false);
    expect((await call('POST', '/apps/notes/publish')).status).toBe(409);
    expect((await call('POST', '/apps/notes/verify')).status).toBe(409);
    token.value = s.body.verify.token;
    const v = await call('POST', '/apps/notes/verify');
    expect(v.body).toEqual({ verified: true, method: 'well-known' });
    const p = await call('POST', '/apps/notes/publish');
    expect(p.body.status).toBe('published');
  });

  test('a second app on a verified origin is verified already', async () => {
    const s = await call('POST', '/apps', { url: `${base}/todo/`, publisher: 'alice-apps', category: 'utilities' });
    expect(s.body.verify.verified).toBe(true);
    expect((await call('POST', '/apps/todo/publish')).body.status).toBe('published');
  });

  test('the public catalog lists, searches and shows published apps only', async () => {
    await call('POST', '/apps', { url: `${base}/secret/`, publisher: 'alice-apps' });
    const list = await anon('GET', '/apps');
    expect(list.body.apps.map((a) => a.slug).sort()).toEqual(['notes', 'todo']);
    const found = await anon('GET', '/apps?q=notes');
    expect(found.body.apps[0].slug).toBe('notes');
    const weird = await anon('GET', `/apps?q=${encodeURIComponent('C++ (beta) & "quotes" -- ;')}`);
    expect(weird.status).toBe(200);
    expect((await anon('GET', '/apps/secret')).status).toBe(404);
    const one = await anon('GET', '/apps/notes');
    expect(one.body.app.installable).toBe(true);
    expect(one.body.app.publisher.slug).toBe('alice-apps');
    expect(one.body.app.links.ios_profile).toBe('/apps/notes/install.mobileconfig');
    const cats = await anon('GET', '/categories');
    expect(cats.body.categories.find((c) => c.slug === 'utilities').apps).toBe(1);
  });

  test('another account cannot touch the app', async () => {
    const bob = req((await keyFor('bob@example.test')).key);
    expect((await bob('PATCH', '/apps/notes', { name: 'pwned' })).status).toBe(404);
    expect((await bob('POST', '/apps', { url: `${base}/x/`, publisher: 'alice-apps' })).status).toBe(404);
  });

  test('installs count and reviews average', async () => {
    await anon('POST', '/apps/notes/installs', { method: 'android' });
    await anon('POST', '/apps/notes/installs', { method: 'open' });
    expect((await anon('POST', '/apps/notes/reviews', { rating: 5 })).status).toBe(401);
    await call('POST', '/apps/notes/reviews', { rating: 4, body: 'good' });
    await call('POST', '/apps/notes/reviews', { rating: 2, body: 'changed my mind' });
    const one = await anon('GET', '/apps/notes');
    expect(one.body.app.installs).toBe(1);
    expect(one.body.app.rating).toBe(2);
    expect(one.body.app.rating_count).toBe(1);
    expect(one.body.reviews[0].body).toBe('changed my mind');
  });

  test('the store pages render and the details page has an Install button', async () => {
    const home = await app.request('/');
    expect(home.status).toBe(200);
    const page = await (await app.request('/apps/notes')).text();
    expect(page).toContain('id="install"');
    expect(page).toContain('application/ld+json');
    expect(page).toContain('The notes app.');
    expect((await app.request('/apps/secret')).status).toBe(404);
    expect((await app.request('/pricing')).status).toBe(200);
    const sm = await (await app.request('/sitemap.xml')).text();
    expect(sm).toContain('/apps/notes');
    expect(sm).not.toContain('/apps/secret');
  });

  test('page values are escaped', async () => {
    await call('PATCH', '/apps/notes', { summary: '<script>alert(1)</script>' });
    const page = await (await app.request('/apps/notes')).text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('the iOS profile is a web clip for the app', async () => {
    const res = await app.request('/apps/notes/install.mobileconfig');
    expect(res.headers.get('content-type')).toBe('application/x-apple-aspen-config');
    const body = await res.text();
    expect(body).toContain('com.apple.webClip.managed');
    expect(body).toContain(`${base}/notes/?pwa`);
    const bundle = await (await app.request('/bundle.mobileconfig?apps=notes,todo')).text();
    expect(bundle.match(/com\.apple\.webClip\.managed/g).length).toBe(2);
  });

  test('the free plan stops at 10 apps', async () => {
    // notes, todo, secret exist; seven more fills it.
    for (let i = 0; i < 7; i++) expect((await call('POST', '/apps', { url: `${base}/fill${i}/`, publisher: 'alice-apps' })).status).toBe(201);
    const over = await call('POST', '/apps', { url: `${base}/eleven/`, publisher: 'alice-apps' });
    expect(over.status).toBe(402);
    expect(over.body.limit).toBe(10);
  });

  test('shared orgs, teams and projects need Unlimited', async () => {
    expect((await call('POST', '/orgs', { name: 'Acme' })).status).toBe(402);
  });

  test('a signed CoinPay webhook grants the plan once', async () => {
    const sql = db();
    const ref = `pay_${randomBytes(6).toString('hex')}`;
    await sql`insert into payments (user_id, provider, provider_ref, amount_cents, status) values (${alice.user.id}, 'coinpay', ${ref}, 19900, 'pending')`;
    const payload = JSON.stringify({ type: 'payment.confirmed', data: { payment_id: ref, status: 'confirmed', metadata: { user_id: alice.user.id, plan: 'unlimited' } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
    const send = (s) => app.request('/webhooks/coinpay', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinpay-signature': s }, body: payload });
    expect((await send(`t=${t},v1=${'0'.repeat(64)}`)).status).toBe(401);
    expect((await send(`t=${t},v1=${sig}`)).status).toBe(200);
    expect((await (await send(`t=${t},v1=${sig}`)).json()).result.result.already).toBe(true);
    const me = await call('GET', '/me');
    expect(me.body.plan.key).toBe('unlimited');
    expect(new Date(me.body.plan.paid_through) > new Date(Date.now() + 360 * 86400_000)).toBe(true);
  });

  test('on Unlimited: orgs, invites, teams, projects and more publishers', async () => {
    const o = await call('POST', '/orgs', { name: 'Acme' });
    expect(o.status).toBe(201);
    const slug = o.body.org.slug;
    expect((await call('POST', `/orgs/${slug}/invites`, { email: 'carol@example.test' })).status).toBe(201);
    expect((await call('POST', `/orgs/${slug}/teams`, { name: 'Design' })).status).toBe(201);
    expect((await call('POST', `/orgs/${slug}/projects`, { name: 'Mobile' })).status).toBe(201);
    expect((await call('POST', '/publishers', { name: 'Acme Studio', org: slug })).status).toBe(201);
    expect((await call('POST', '/apps', { url: `${base}/eleven/`, publisher: 'acme-studio', project: 'mobile' })).status).toBe(201);
    // Carol signs in and lands in the org through the invite.
    const carol = await auth.findOrCreateUser('carol@example.test');
    const carolCall = req((await auth.createApiKey({ userId: carol.id })).key);
    const me = await carolCall('GET', '/me');
    expect(me.body.orgs.some((x) => x.slug === slug && x.role === 'member')).toBe(true);
    expect(me.body.publishers.some((p) => p.slug === 'acme-studio')).toBe(true);
  });

  test('staff can feature an app; others cannot reach admin', async () => {
    expect((await call('POST', '/admin/apps/notes', { featured: true })).status).toBe(404);
    const staff = req((await keyFor('staff@example.test')).key);
    expect((await staff('POST', '/admin/apps/notes', { featured: true })).body.app.featured).toBe(true);
    expect((await anon('GET', '/apps?featured=1')).body.apps[0].slug).toBe('notes');
  });

  test('MCP: initialize, list and call tools over POST /mcp', async () => {
    const rpc = async (body, key) =>
      (await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })).json();
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.result.serverInfo.name).toBe('pwamart');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.result.tools.map((t) => t.name)).toContain('install_app');
    const found = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_apps', arguments: { query: 'todo' } } });
    expect(JSON.parse(found.result.content[0].text).apps[0].slug).toBe('todo');
    const inst = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'install_app', arguments: { slug: 'todo', platform: 'ios' } } });
    expect(JSON.parse(inst.result.content[0].text).steps[1]).toContain('install.mobileconfig');
    const anonSubmit = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'submit_app', arguments: { url: `${base}/z/`, publisher: 'alice-apps' } } });
    expect(anonSubmit.result.isError).toBe(true);
    const mine = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'verify_app', arguments: { slug: 'notes' } } }, alice.key);
    expect(JSON.parse(mine.result.content[0].text).verified).toBe(true);
  });

  test('the inspector refuses private addresses outside tests', async () => {
    inspectMod.setAllowLocal(false);
    try {
      expect((await call('POST', '/inspect', { url: 'https://127.0.0.1/' })).status).toBe(422);
      expect((await call('POST', '/inspect', { url: 'http://example.com/' })).status).toBe(422);
      expect((await call('POST', '/inspect', { url: 'https://169.254.169.254/latest/meta-data' })).status).toBe(422);
    } finally {
      inspectMod.setAllowLocal(true);
    }
  });
});
