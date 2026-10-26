/**
 * Credit codes (Pro days through the plan path) and invites (single use, new
 * accounts only, bonus behind the abuse checks). Pure parts run anywhere; the
 * rest against a real Postgres (DATABASE_URL), like api.test.js.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

const cr = await import('../apps/web/src/credits.js');

describe('credits: pure rules', () => {
  test('one mailbox under two spellings', () => {
    expect(cr.sameMailbox('Ada@Acme.com', 'ada+pwa@acme.com')).toBe(true);
    expect(cr.sameMailbox('a.d.a@gmail.com', 'ada+x@googlemail.com')).toBe(true);
    expect(cr.sameMailbox('a.da@acme.com', 'ada@acme.com')).toBe(false);
    expect(cr.sameMailbox('ada@acme.com', 'ada@acme.org')).toBe(false);
  });
  test('codes and refs are cleaned before they reach the packages', () => {
    expect(cr.canonicalInvite('inv 7k3m qx9d 2f8h')).toBe('INV-7K3M-QX9D-2F8H');
    expect(cr.canonicalInvite('7K3M-QX9D-2F8H')).toBe('INV-7K3M-QX9D-2F8H');
    expect(cr.canonicalInvite('<script>')).toBeNull();
    expect(cr.canonicalInvite('PM-AAAA-BBBB-CCCC-DDDD')).toBeNull();
    expect(cr.cleanRef('e6ketybk')).toBe('E6KETYBK');
    expect(cr.cleanRef('x')).toBeNull();
    expect(cr.cleanRef('a b c d')).toBeNull();
    expect(cr.cleanCode('x'.repeat(49))).toBeNull();
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

d('credits + invites end to end', () => {
  let app, auth, db;
  const run = randomBytes(4).toString('hex');
  const users = {};
  const calls = {};

  const req = (key) => async (method, path, body) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  async function member(name, { ageHours = 0 } = {}) {
    const user = await auth.findOrCreateUser(`${name}-${run}@example.test`);
    if (ageHours) await db()`update users set created_at = now() - make_interval(hours => ${ageHours}) where id = ${user.id}`;
    const { key } = await auth.createApiKey({ userId: user.id });
    users[name] = user;
    calls[name] = req(key);
    return user;
  }
  /** Sign up through the emailed link, the way a browser does; returns the new user. */
  async function signUp(email, { invite = null, ref = null, cookie = '' } = {}) {
    const url = await auth.createLoginLink(email, { invite, ref });
    const res = await app.request(`/auth/magic?t=${new URL(url).searchParams.get('t')}`, { headers: cookie ? { cookie } : {} });
    expect(res.status).toBe(302);
    const [u] = await db()`select * from users where lower(email) = ${email.toLowerCase()}`;
    return u;
  }
  const plan = async (u) => (await import('../apps/web/src/billing.js')).currentPlan(u.id);
  const bonuses = (inviteId) => db()`select user_id, role, days, status from invite_bonuses where invite_id = ${inviteId} order by role`;

  beforeAll(async () => {
    process.env.SITE_URL ??= 'http://localhost:3999';
    process.env.ADMIN_EMAILS ??= 'staff@example.test';
    process.env.INVITE_BONUS_DAYS = '30';
    const dbm = await import('../packages/db/src/index.js');
    db = dbm.db;
    await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
    app = (await import('../apps/web/src/app.js')).app;
    auth = await import('../apps/web/src/auth.js');
    await member('buyer');
    await member('other');
    await member('inviter', { ageHours: 72 });
    await member('newbie', { ageHours: 0 });
    const staff = await auth.findOrCreateUser('staff@example.test');
    calls.staff = req((await auth.createApiKey({ userId: staff.id })).key);
    await calls.staff('GET', '/me'); // flips is_admin from ADMIN_EMAILS
  });
  afterAll(async () => {
    const { close } = await import('../packages/db/src/index.js');
    await close();
  });

  test('only staff mint; a code grants Pro days once per account, through plan_periods', async () => {
    expect((await calls.buyer('POST', '/admin/credit-codes', { days: 30 })).status).toBe(404);
    expect((await calls.staff('POST', '/admin/credit-codes', { days: 0 })).status).toBe(400);
    const m = await calls.staff('POST', '/admin/credit-codes', { days: 45, label: `test ${run}`, max_redemptions: 2 });
    expect(m.status).toBe(201);
    expect(m.body.code).toMatch(/^PM-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect((await plan(users.buyer)).key).toBe('free');

    // Forgiving input: lower case, spaces instead of dashes.
    const r = await calls.buyer('POST', '/credits/redeem', { code: m.body.code.toLowerCase().replaceAll('-', ' ') });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, days: 45, plan: 'pro' });
    const p = await plan(users.buyer);
    expect(p.key).toBe('pro');
    const days = (new Date(p.paid_through) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(44.9);
    expect(days).toBeLessThan(45.1);
    const [row] = await db()`select provider, amount_cents from payments where user_id = ${users.buyer.id}`;
    expect(row).toMatchObject({ provider: 'grant', amount_cents: 0 });

    // The same account again: refused, nothing added.
    const again = await calls.buyer('POST', '/credits/redeem', { code: m.body.code });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('already_redeemed');
    expect((await db()`select count(*)::int as n from plan_periods where user_id = ${users.buyer.id}`)[0].n).toBe(1);

    // A second account uses the second redemption; a third finds it used up.
    expect((await calls.other('POST', '/credits/redeem', { code: m.body.code })).status).toBe(200);
    const late = await calls.newbie('POST', '/credits/redeem', { code: m.body.code });
    expect(late.body.reason).toBe('used_up');
    expect((await calls.newbie('POST', '/credits/redeem', { code: 'PM-0000-0000-0000-0000' })).body.reason).toBe('invalid');

    const list = await calls.buyer('GET', '/credits');
    expect(list.body).toMatchObject({ unit: 'pro_days', days: 45 });
    // The billing page lists it as applied, at $0.
    const b = await calls.buyer('GET', '/billing');
    expect(b.body.payments[0]).toMatchObject({ amount_cents: 0, product: 'code', applied: true });
  });

  test('a second code queues after the first; gift days are never upgrade credit', async () => {
    const m = await calls.staff('POST', '/admin/credit-codes', { days: 10 });
    const before = (await plan(users.buyer)).paid_through;
    expect((await calls.buyer('POST', '/credits/redeem', { code: m.body.code })).status).toBe(200);
    const periods = await db()`select starts_at, ends_at from plan_periods where user_id = ${users.buyer.id} order by starts_at`;
    expect(periods).toHaveLength(2);
    expect(new Date(periods[1].starts_at).getTime()).toBe(new Date(before).getTime());
    const q = await calls.buyer('GET', '/billing/quote?plan=unlimited');
    expect(q.body).toMatchObject({ kind: 'upgrade', credit_cents: 0, amount_cents: 19900 });
  });

  test('a lost grant heals on the next read, and never twice', async () => {
    const m = await calls.staff('POST', '/admin/credit-codes', { days: 7 });
    // The package records the redemption, then the process "dies" before the plan grant.
    const r = await cr.creditServices().credits.redeem(m.body.code, String(users.other.id));
    expect(r.ok).toBe(true);
    const n = async () => (await db()`select count(*)::int as n from plan_periods where user_id = ${users.other.id}`)[0].n;
    const was = await n();
    await calls.other('GET', '/credits');
    expect(await n()).toBe(was + 1);
    await calls.other('GET', '/credits');
    expect(await n()).toBe(was + 1);
  });

  test('revoked codes are refused', async () => {
    const m = await calls.staff('POST', '/admin/credit-codes', { days: 5 });
    expect((await calls.staff('DELETE', `/admin/credit-codes/${m.body.id}`)).status).toBe(200);
    expect((await calls.newbie('POST', '/credits/redeem', { code: m.body.code })).body.reason).toBe('revoked');
  });

  test('invites: three each, a landing page, accepted once by a new account, both get Pro days', async () => {
    const s = await calls.inviter('GET', '/invites');
    expect(s.body.quota).toEqual({ total: 3, used: 0, left: 3 });
    expect(s.body.affiliate_url).toMatch(/\/\?ref=[0-9A-Z]+$/);
    const inv = await calls.inviter('POST', '/invites', { note: 'for Ada' });
    expect(inv.status).toBe(201);
    expect(inv.body.url).toEndWith(`/i/${inv.body.code}`);

    const landing = await app.request(`/i/${inv.body.code.toLowerCase()}`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('Accept the invite');
    expect(landing.headers.get('set-cookie')).toContain(`pm_invite=${inv.body.code}`);
    expect((await app.request('/i/INV-0000-0000-0000')).status).toBe(404);

    // The cookie rides /auth/link onto the emailed token (another device can open it).
    const email = `ada-${run}@example.org`;
    const link = await app.request('/api/v1/auth/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `pm_invite=${inv.body.code}; referral_code=NOPE1234` },
      body: JSON.stringify({ email }),
    });
    expect(link.status).toBe(200);
    const [tok] = await db()`select invite_code, ref_code from login_tokens where email = ${email}`;
    expect(tok).toEqual({ invite_code: inv.body.code, ref_code: 'NOPE1234' });

    // Opened with no cookie at all: the link alone carries the invite.
    const ada = await signUp(email, { invite: inv.body.code });
    const rows = await bonuses(inv.body.invite.id);
    expect(rows.map((r) => [r.role, r.status, r.days])).toEqual([
      ['invitee', 'granted', 30],
      ['inviter', 'granted', 30],
    ]);
    expect((await plan(ada)).key).toBe('pro');
    expect((await plan(users.inviter)).key).toBe('pro');

    // Used: the next new account gets nothing, and the landing page says so.
    const bob = await signUp(`bob-${run}@example.org`, { invite: inv.body.code });
    expect((await plan(bob)).key).toBe('free');
    expect((await app.request(`/i/${inv.body.code}`)).status).toBe(404);
    const after = await calls.inviter('GET', '/invites');
    expect(after.body).toMatchObject({ invited: 1, bonus_days_earned: 30, quota: { left: 2 } });
  });

  test('an existing account never takes an invite', async () => {
    const inv = await calls.inviter('POST', '/invites', {});
    const before = await plan(users.buyer);
    const url = await auth.createLoginLink(users.buyer.email, { invite: inv.body.code });
    await app.request(`/auth/magic?t=${new URL(url).searchParams.get('t')}`);
    expect(await bonuses(inv.body.invite.id)).toEqual([]);
    expect((await plan(users.buyer)).paid_through).toEqual(before.paid_through);
    // Still open for someone new; give the slot back.
    expect((await calls.inviter('DELETE', `/invites/${inv.body.invite.id}`)).status).toBe(200);
    expect((await calls.other('DELETE', `/invites/${inv.body.invite.id}`)).status).toBe(404);
  });

  test('no bonus for the same mailbox, a throwaway inbox, or a brand-new inviter; the invite is still spent', async () => {
    const same = await calls.inviter('POST', '/invites', {});
    const alias = await signUp(`inviter-${run}+2@example.test`, { invite: same.body.code });
    expect((await bonuses(same.body.invite.id)).map((r) => r.status)).toEqual(['same_mailbox', 'same_mailbox']);
    expect((await plan(alias)).key).toBe('free');

    const toss = await calls.inviter('POST', '/invites', {});
    const throwaway = await signUp(`x-${run}@mailinator.com`, { invite: toss.body.code });
    expect((await bonuses(toss.body.invite.id)).map((r) => r.status)).toEqual(['disposable', 'disposable']);
    expect((await plan(throwaway)).key).toBe('free');

    const fresh = await calls.newbie('POST', '/invites', {});
    const pal = await signUp(`pal-${run}@example.org`, { invite: fresh.body.code });
    expect((await bonuses(fresh.body.invite.id)).map((r) => r.status)).toEqual(['inviter_too_new', 'inviter_too_new']);
    expect((await plan(pal)).key).toBe('free');
  });

  test('?ref= is remembered first-touch and credits a new account to the affiliate', async () => {
    const code = (await calls.inviter('GET', '/invites')).body.affiliate_code;
    const res = await app.request(`/?ref=${code.toLowerCase()}`);
    expect(res.headers.get('set-cookie')).toContain(`referral_code=${code}`);
    const kept = await app.request(`/?ref=OTHER123`, { headers: { cookie: `referral_code=${code}` } });
    expect(kept.headers.get('set-cookie') ?? '').not.toContain('OTHER123');
    const eve = await signUp(`eve-${run}@example.org`, { cookie: `referral_code=${code}` });
    expect(await cr.creditServices().affiliates.affiliateOf(String(eve.id))).toBe(String(users.inviter.id));
  });
});
