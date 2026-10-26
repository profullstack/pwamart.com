/**
 * Karma: the ledger, its caps and dedupe, self-dealing, comment reversal, credits,
 * the leaderboard and every surface that pays. The pure parts run anywhere; the rest
 * against a real Postgres (DATABASE_URL), like api.test.js.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

const k = await import('../apps/web/src/karma.js');

describe('karma: pure rules', () => {
  test('the next free Featured week, and a dip never re-offers a granted one', () => {
    expect(k.nextCredit(0, 0, 500)).toMatchObject({ at: 500, remaining: 500, progress: 0 });
    expect(k.nextCredit(499, 0, 500).remaining).toBe(1);
    expect(k.nextCredit(500, 1, 500)).toMatchObject({ at: 1000, remaining: 500 });
    // Granted milestone 1, then karma fell to 480: the next one is still at 1000.
    expect(k.nextCredit(480, 1, 500)).toMatchObject({ at: 1000, remaining: 520 });
    expect(k.nextCredit(-5, 0, 500).remaining).toBe(505);
  });
  test('the same points table as built.indie; unpaid rows are not advertised', () => {
    const t = Object.fromEntries(k.howToEarn().map((r) => [r.action, r.points]));
    expect(t).toEqual({ publish: 10, vote: 1, review: 5, comment: 2, share: 1, received_vote: 1, received_review: 2, verify: 5, badge: 5 });
    expect(k.ACTIONS.vote.daily).toBe(20);
    expect(k.ACTIONS.comment.daily).toBe(10);
    expect(k.ACTIONS.share.daily).toBe(5);
  });
  test('player ids are stable, short and not the account id', () => {
    const id = '7d3c2a4e-0000-4000-8000-000000000001';
    expect(k.playerId(id)).toBe(k.playerId(id));
    expect(k.playerId(id)).toMatch(/^[0-9a-f]{12}$/);
    expect(k.playerId(id)).not.toContain('7d3c');
    expect(k.dayOf(new Date('2026-10-26T23:59:00Z'))).toBe('2026-10-26');
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

d('karma end to end', () => {
  let app, auth, db, orgs;
  const run = randomBytes(4).toString('hex');
  const users = {};
  const calls = {};
  const apps = {};

  const req = (key) => async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  async function member(name) {
    const user = await auth.findOrCreateUser(`${name}-${run}@example.test`);
    const { key } = await auth.createApiKey({ userId: user.id });
    users[name] = user;
    calls[name] = req(key);
    return user;
  }
  /** A live listing published by `owner`'s personal org, straight into the tables. */
  async function listing(owner, slug) {
    const sql = db();
    const org = await orgs.ensurePersonalOrg(sql, { userId: owner.id, name: owner.email.split('@')[0] });
    let [p] = await sql`select id from publishers where org_id = ${org.id}`;
    if (!p) [p] = await sql`insert into publishers (org_id, slug, name, created_by) values (${org.id}, ${`pub-${slug}`}, ${`Pub ${slug}`}, ${owner.id}) returning id`;
    const [a] = await sql`insert into apps (publisher_id, slug, name, url, origin, verify_token, status, published_at, verified_at, verified_by)
      values (${p.id}, ${slug}, ${`App ${slug}`}, ${`https://${slug}.example.test/`}, ${`https://${slug}.example.test`}, 'tok', 'published', now(), now(), 'staff') returning id`;
    apps[slug] = a.id;
    return a.id;
  }
  const total = async (u) => k.karmaOf(u.id);
  const rows = (u, action) => db()`select action, ref, bucket, points from karma_events where user_id = ${u.id} ${action ? db()`and action = ${action}` : db()``} order by id`;

  beforeAll(async () => {
    process.env.SITE_URL ??= 'http://localhost:3999';
    process.env.ADMIN_EMAILS ??= 'staff@example.test';
    const dbm = await import('../packages/db/src/index.js');
    db = dbm.db;
    orgs = dbm.orgs;
    await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
    app = (await import('../apps/web/src/app.js')).app;
    auth = await import('../apps/web/src/auth.js');
    for (const n of ['maker', 'fan', 'critic', 'chatter', 'sharer']) await member(n);
    const staff = await auth.findOrCreateUser('staff@example.test');
    users.staff = staff;
    calls.staff = req((await auth.createApiKey({ userId: staff.id })).key);
    await calls.staff('GET', '/me'); // flips is_admin from ADMIN_EMAILS
    await listing(users.maker, `kapp-${run}`);
  });
  afterAll(async () => {
    const { close } = await import('../packages/db/src/index.js');
    await close();
  });

  const slug = () => `kapp-${run}`;

  test('the ledger dedupes: the same action on the same thing pays once', async () => {
    const a = await k.award({ userId: users.fan.id, action: 'verify', ref: `dedupe-${run}` });
    const b = await k.award({ userId: users.fan.id, action: 'verify', ref: `dedupe-${run}` });
    expect(a).toMatchObject({ paid: true, points: 5 });
    expect(b).toMatchObject({ paid: false, reason: 'already paid' });
    expect(await total(users.fan)).toBe(5);
    expect((await k.award({ userId: null, action: 'vote', ref: 'x' })).reason).toBe('anonymous');
    await expect(k.award({ userId: users.fan.id, action: 'install', ref: 'x' })).rejects.toThrow('unknown karma action');
  });

  test('a reversal is a new negative row, once', async () => {
    const r1 = await k.reverse({ userId: users.fan.id, action: 'verify', ref: `dedupe-${run}` });
    const r2 = await k.reverse({ userId: users.fan.id, action: 'verify', ref: `dedupe-${run}` });
    expect(r1).toMatchObject({ reversed: true, points: -5 });
    expect(r2.reversed).toBe(false);
    expect(await total(users.fan)).toBe(0);
    expect((await rows(users.fan, 'verify')).map((r) => r.points)).toEqual([5, -5]);
  });

  test('daily caps: 20 paid votes, 10 paid comments, 5 paid shares', async () => {
    const u = await member('capper');
    const pay = async (action, n, bucket = '') => {
      let paid = 0;
      for (let i = 0; i < n; i++) if ((await k.award({ userId: u.id, action, ref: `${action}-${i}-${run}`, bucket })).paid) paid++;
      return paid;
    };
    expect(await pay('vote', 22)).toBe(20);
    expect(await pay('comment', 12)).toBe(10);
    expect(await pay('share', 7, k.dayOf())).toBe(5);
    expect((await k.award({ userId: u.id, action: 'vote', ref: 'one-more' })).reason).toBe('daily cap of 20');
    expect(await total(u)).toBe(20 + 20 + 5);
  });

  test('upvote: +1 to the voter and +1 to the owner, once; the count follows the toggle', async () => {
    const s = slug();
    expect((await req(null)('POST', `/apps/${s}/vote`)).status).toBe(401);
    const v = await calls.fan('POST', `/apps/${s}/vote`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ voted: true, votes: 1, karma: { paid: true, points: 1 } });
    expect((await calls.fan('POST', `/apps/${s}/vote`)).body.votes).toBe(1); // idempotent
    expect((await calls.fan('DELETE', `/apps/${s}/vote`)).body).toMatchObject({ voted: false, votes: 0 });
    const again = await calls.fan('POST', `/apps/${s}/vote`);
    expect(again.body.votes).toBe(1);
    expect(again.body.karma).toMatchObject({ paid: false, reason: 'already paid' });
    expect((await rows(users.fan, 'vote')).length).toBe(1);
    expect((await rows(users.maker, 'received_vote')).length).toBe(1);
    const card = (await req(null)('GET', `/apps/${s}`)).body.app;
    expect(card.votes).toBe(1);
    expect((await req(null)('GET', '/apps?sort=votes&limit=100')).body.apps[0].slug).toBe(s);
  });

  test('self-dealing earns nothing: own votes, reviews, comments and shares', async () => {
    const s = slug();
    const before = await total(users.maker);
    expect((await calls.maker('POST', `/apps/${s}/vote`)).body.karma).toMatchObject({ paid: false, reason: 'your own app' });
    expect((await calls.maker('POST', `/apps/${s}/reviews`, { rating: 5, body: 'I made this and it is the best app ever made, honestly.' })).body.karma.reason).toBe('your own app');
    expect((await calls.maker('POST', `/apps/${s}/comments`, { body: 'Thanks everyone for trying it out!' })).body.comment.karma.reason).toBe('your own app');
    expect((await calls.maker('POST', `/apps/${s}/share`, { network: 'x' })).body.karma.reason).toBe('your own app');
    expect(await total(users.maker)).toBe(before);
    // Still counted as a vote, just unpaid.
    expect((await req(null)('GET', `/apps/${s}/vote`)).body.votes).toBe(2);
  });

  test('staff accounts earn nothing (bulk seeding must not top the board)', async () => {
    const r = await calls.staff('POST', `/apps/${slug()}/vote`);
    expect(r.body.karma).toMatchObject({ paid: false, reason: 'staff' });
    expect(await total(users.staff)).toBe(0);
  });

  test('reviews: 30+ characters pays 5 once; every new review pays the owner 2', async () => {
    const s = slug();
    const ownerBefore = await total(users.maker);
    const short = await calls.critic('POST', `/apps/${s}/reviews`, { rating: 4, body: 'Nice.' });
    expect(short.body.karma.paid).toBe(false);
    expect(await total(users.maker)).toBe(ownerBefore + 2);
    const long = await calls.critic('POST', `/apps/${s}/reviews`, { rating: 5, body: 'Installs in one tap and works offline on the train.' });
    expect(long.body.karma).toMatchObject({ paid: true, points: 5 });
    const edit = await calls.critic('POST', `/apps/${s}/reviews`, { rating: 5, body: 'Installs in one tap and works offline on the train. Edited.' });
    expect(edit.body.karma.reason).toBe('already paid');
    expect(await total(users.critic)).toBe(5);
    expect(await total(users.maker)).toBe(ownerBefore + 2); // the edit is not a new review
    const reviews = (await req(null)('GET', `/apps/${s}/reviews`)).body.reviews;
    expect(reviews[0].karma).toBe(5);
  });

  test('comments: reply one level deep, karma by the names, delete reverses, staff can delete, rate limited', async () => {
    const s = slug();
    expect((await req(null)('POST', `/apps/${s}/comments`, { body: 'anonymous hello there' })).status).toBe(401);
    const c = await calls.chatter('POST', `/apps/${s}/comments`, { body: 'Does it sync between devices? <script>alert(1)</script>' });
    expect(c.status).toBe(201);
    expect(c.body.comment.karma).toMatchObject({ paid: true, points: 2 });
    const short = await calls.chatter('POST', `/apps/${s}/comments`, { body: 'nice', parent: c.body.comment.id });
    expect(short.body.comment.karma.paid).toBe(false);
    const r = await calls.fan('POST', `/apps/${s}/comments`, { body: 'Yes, through your account.', parent: c.body.comment.id });
    // A reply to a reply joins the same thread.
    const rr = await calls.chatter('POST', `/apps/${s}/comments`, { body: 'Great, thank you!!', parent: r.body.comment.id });
    expect(rr.body.comment.parent_id).toBe(c.body.comment.id);
    const list = (await calls.chatter('GET', `/apps/${s}/comments`)).body;
    const top = list.comments.find((x) => x.id === c.body.comment.id);
    expect(top.replies.length).toBe(3);
    expect(top.karma).toBe(await total(users.chatter));
    expect(top.mine).toBe(true);
    expect(top.replies.find((x) => x.author.startsWith('fan')).can_delete).toBe(false);

    // The page escapes everything and shows karma next to the name.
    const html = await (await app.request(`/apps/${s}`)).text();
    expect(html).toContain('Does it sync between devices? &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('class="karma-chip"');
    expect(html).toContain(`/api/v1/coinpay/login?next=${encodeURIComponent(`/apps/${s}#comments`)}`);

    // Not yours: 404. Yours: deleted and the 2 karma go back, once.
    expect((await calls.fan('DELETE', `/comments/${c.body.comment.id}`)).status).toBe(404);
    const before = await total(users.chatter);
    const del = await calls.chatter('DELETE', `/comments/${c.body.comment.id}`);
    expect(del.body).toEqual({ deleted: true, karma_reversed: -2 });
    expect(await total(users.chatter)).toBe(before - 2);
    expect((await calls.chatter('DELETE', `/comments/${c.body.comment.id}`)).status).toBe(404);
    // Staff remove the fan's reply, which takes the fan's karma back too.
    const fanBefore = await total(users.fan);
    expect((await calls.staff('DELETE', `/comments/${r.body.comment.id}`)).body.karma_reversed).toBe(-2);
    expect(await total(users.fan)).toBe(fanBefore - 2);
    const after = (await req(null)('GET', `/apps/${s}/comments`)).body.comments.find((x) => x.id === c.body.comment.id);
    expect(after).toMatchObject({ deleted: true, body: null, author: null });
    expect(after.replies.length).toBe(2);

    // 5 a minute.
    const spam = await member('spammer');
    let last;
    for (let i = 0; i < 6; i++) last = await calls.spammer('POST', `/apps/${s}/comments`, { body: `comment number ${i} here` });
    expect(last.status).toBe(429);
    expect(spam).toBeTruthy();
  });

  test('shares: tracked networks only, once per app per network a day; anonymous earns nothing', async () => {
    const s = slug();
    expect((await req(null)('POST', `/apps/${s}/share`, { network: 'x' })).body.karma.paid).toBe(false);
    expect((await calls.sharer('POST', `/apps/${s}/share`, { network: 'x' })).body.karma.paid).toBe(true);
    expect((await calls.sharer('POST', `/apps/${s}/share`, { network: 'x' })).body.karma.reason).toBe('already paid');
    expect((await calls.sharer('POST', `/apps/${s}/share`, { network: 'bluesky' })).body.karma.paid).toBe(true);
    expect((await calls.sharer('POST', `/apps/${s}/share`, { network: 'myspace' })).body.karma.paid).toBe(false);
    expect((await rows(users.sharer, 'share')).every((r) => r.bucket === k.dayOf())).toBe(true);
    expect(await total(users.sharer)).toBe(2);
  });

  test('publish pays 10 the first time a listing goes live; verify pays 5 once; installs pay nothing', async () => {
    const u = await member('publisher');
    const sql = db();
    const org = await orgs.ensurePersonalOrg(sql, { userId: u.id, name: 'publisher' });
    const [p] = await sql`insert into publishers (org_id, slug, name, created_by) values (${org.id}, ${`pp-${run}`}, 'PP', ${u.id}) returning id`;
    const s = `pub-app-${run}`;
    await sql`insert into apps (publisher_id, slug, name, url, origin, verify_token, verified_at, verified_by)
              values (${p.id}, ${s}, 'PP app', 'https://pp.example.test/', 'https://pp.example.test', 'tok', now(), 'well-known')`;
    const first = await calls.publisher('POST', `/apps/${s}/publish`);
    expect(first.body.karma).toMatchObject({ paid: true, points: 10 });
    await calls.publisher('POST', `/apps/${s}/unpublish`);
    const second = await calls.publisher('POST', `/apps/${s}/publish`);
    expect(second.body.karma).toBeUndefined();
    expect((await k.award({ userId: u.id, action: 'verify', ref: (await sql`select id from apps where slug = ${s}`)[0].id })).points).toBe(5);
    await calls.publisher('POST', `/apps/${s}/installs`, { method: 'web' });
    expect(await total(u)).toBe(15);
  });

  test('badge: a verified link back pays the listing owner 5, once', async () => {
    const { checkBadge } = await import('../apps/web/src/badge.js');
    const { config } = await import('../apps/web/src/config.js');
    const s = slug();
    const row = { id: apps[s], slug: s, url: `https://${s}.example.test/`, origin: `https://${s}.example.test` };
    const fetchFn = async () => ({ status: 200, text: `<a href="${config.siteUrl}/apps/${s}"><img src="${config.siteUrl}/apps/${s}/badge.svg"></a>` });
    const before = await total(users.maker);
    expect((await checkBadge(row, { siteUrl: config.siteUrl, fetchFn })).verified).toBe(true);
    await checkBadge(row, { siteUrl: config.siteUrl, fetchFn });
    expect(await total(users.maker)).toBe(before + 5);
    expect((await rows(users.maker, 'badge')).length).toBe(1);
  });

  test('credits: every 500 karma grants one free Featured week, never twice, spent through the featured grant', async () => {
    const u = users.fan;
    const sql = db();
    const now = await total(u);
    await sql`insert into karma_events (user_id, action, ref, points) values (${u.id}, 'seed', ${`seed-${run}`}, ${499 - now})`;
    expect((await calls.fan('GET', '/karma')).body.next_credit).toMatchObject({ at: 500, remaining: 1 });
    const cross = await k.award({ userId: u.id, action: 'verify', ref: `cross-${run}` });
    expect(cross).toMatchObject({ paid: true, credits: 1 });
    // Dip below and cross again: no second credit for the same milestone.
    await k.reverse({ userId: u.id, action: 'verify', ref: `cross-${run}` });
    await k.award({ userId: u.id, action: 'verify', ref: `cross2-${run}` });
    const me = (await calls.fan('GET', '/karma')).body;
    expect(me.credits).toMatchObject({ available: 1, granted: 1 });
    expect(me.next_credit.at).toBe(1000);
    expect((await calls.fan('GET', '/me')).body.karma).toMatchObject({ total: 504, credits_available: 1 });

    // Spend it on one of the fan's own live apps.
    await listing(u, `fan-app-${run}`);
    expect((await calls.critic('POST', `/apps/fan-app-${run}/feature`, { credit: true })).status).toBe(404);
    const spent = await calls.fan('POST', `/apps/fan-app-${run}/feature`, { credit: true });
    expect(spent.status).toBe(200);
    expect(spent.body).toMatchObject({ featured: true, paid_with: 'credit', credits_left: 0 });
    const [slot] = await sql`select s.paid_with, p.provider, p.amount_cents from featured_slots s join payments p on p.id = s.payment_id where s.app_id = ${apps[`fan-app-${run}`]}`;
    expect(slot).toMatchObject({ paid_with: 'credit', provider: 'karma', amount_cents: 0 });
    expect((await calls.fan('GET', `/apps/fan-app-${run}/featured`)).body.featured).toBe(true);
    const none = await calls.fan('POST', `/apps/fan-app-${run}/feature`, { credit: true });
    expect(none.status).toBe(402);
    expect((await calls.fan('GET', '/karma')).body.credits).toMatchObject({ available: 0, spent: 1 });
  });

  test('the leaderboard: API, badges, page, home widget, package JSON', async () => {
    await k.touched(users.fan.id);
    const lb = await req(null)('GET', '/leaderboard?period=week');
    expect(lb.status).toBe(200);
    const fan = lb.body.rows.find((r) => r.id === k.playerId(users.fan.id));
    expect(fan.value).toBe(504);
    expect(fan.badges.map((b) => b.id)).toEqual(expect.arrayContaining(['first-karma', 'karma-100']));
    expect(lb.body.rows.some((r) => r.id === k.playerId(users.staff.id))).toBe(false);
    expect(lb.body.how_to_earn.length).toBe(9);
    const me = (await calls.fan('GET', '/karma')).body;
    expect(me.rank.week).toBeGreaterThanOrEqual(1);
    expect(me.badges.length).toBeGreaterThanOrEqual(2);
    expect((await req(null)('GET', '/karma')).status).toBe(401);

    const page = await app.request('/leaderboard');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('How to earn karma');
    expect(html).toContain('href="/leaderboard/u/');
    expect(html).toContain('Continue with CoinPay');
    expect(html).toContain('/api/v1/coinpay/login?next=%2Fleaderboard');
    const home = await (await app.request('/')).text();
    expect(home).toMatch(/Top karma (this week|, all time)/);
    expect(home).toContain('href="/leaderboard"');
    const json = await app.request('/leaderboard/karma.json?period=all');
    expect((await json.json()).rows.length).toBeGreaterThan(0);
    expect((await app.request('/leaderboard.json')).status).toBe(200);
    expect((await app.request(`/leaderboard/u/${k.playerId(users.fan.id)}`)).status).toBe(200);
  });

  test('MCP: my_karma, leaderboard, upvote_app, comment over POST /mcp', async () => {
    const rpc = async (name, args, key) => {
      const res = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      return (await res.json()).result;
    };
    const { key } = await auth.createApiKey({ userId: users.critic.id });
    const board = JSON.parse((await rpc('leaderboard', { period: 'all' })).content[0].text);
    expect(board.rows.length).toBeGreaterThan(0);
    const mine = JSON.parse((await rpc('my_karma', {}, key)).content[0].text);
    expect(mine.total).toBe(await total(users.critic));
    const v = JSON.parse((await rpc('upvote_app', { slug: slug() }, key)).content[0].text);
    expect(v.voted).toBe(true);
    const c = JSON.parse((await rpc('comment', { slug: slug(), text: 'Asked from an agent, works well.' }, key)).content[0].text);
    expect(c.comment.karma.paid).toBe(true);
    expect((await rpc('my_karma', {})).isError).toBe(true);
  });
});
