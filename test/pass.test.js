/**
 * Profullstack Pass: an active CoinPay `pass` claim is Unlimited until it expires,
 * once per pass, through the same gift path as credit codes. Pure parts run
 * anywhere; the grant against a real Postgres (DATABASE_URL), like api.test.js.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

const billing = await import('../apps/web/src/billing.js');
const DAY = 86_400_000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();

describe('pass: reading the claim', () => {
  test('active only with active === true and a future expires_at', () => {
    expect(billing.passFromClaims({ pass: { active: true, expires_at: future(5) } }).active).toBe(true);
    expect(billing.passFromClaims({ pass: { active: true, expires_at: future(-1) } }).active).toBe(false);
    expect(billing.passFromClaims({ pass: { active: true } }).active).toBe(false);
    expect(billing.passFromClaims({ pass: { active: true, expires_at: 'nope' } }).active).toBe(false);
    expect(billing.passFromClaims({ pass: { active: 'true', expires_at: future(5) } }).active).toBe(false);
    expect(billing.passFromClaims({ pass: { active: false, expires_at: future(5) } }).active).toBe(false);
    expect(billing.passFromClaims({ sub: 'x' }).active).toBe(false);
    expect(billing.passFromClaims(null).active).toBe(false);
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

d('pass: granting the top plan', () => {
  let db;
  let auth;
  const run = randomBytes(4).toString('hex');
  beforeAll(async () => {
    process.env.SITE_URL ??= 'http://localhost:3999';
    const dbm = await import('../packages/db/src/index.js');
    db = dbm.db;
    await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
    auth = await import('../apps/web/src/auth.js');
  });

  test('an active pass is Unlimited until it expires, granted once', async () => {
    const user = await auth.findOrCreateUser(`pass-${run}@example.test`);
    const exp = future(20);
    const pass = billing.passFromClaims({ pass: { active: true, expires_at: exp } });
    const first = await db().begin((tx) => billing.grantPass(tx, { userId: user.id, sub: `sub-${run}`, pass }));
    expect(first.granted).toBe(true);
    const again = await db().begin((tx) => billing.grantPass(tx, { userId: user.id, sub: `sub-${run}`, pass }));
    expect(again).toEqual({ already: true });
    const plan = await billing.currentPlan(user.id);
    expect(plan.key).toBe('unlimited');
    expect(new Date(plan.paid_through).toISOString()).toBe(exp);
    const periods = await db()`select 1 from plan_periods where user_id = ${user.id}`;
    expect(periods.length).toBe(1);
    // A paid year bought during the pass queues after it.
    const q = await billing.quote(user.id, 'unlimited');
    expect(new Date(q.starts_at).toISOString()).toBe(exp);
  });

  test('no pass grants nothing', async () => {
    const user = await auth.findOrCreateUser(`nopass-${run}@example.test`);
    const pass = billing.passFromClaims({ pass: { active: false } });
    expect(await db().begin((tx) => billing.grantPass(tx, { userId: user.id, sub: `n-${run}`, pass }))).toBeNull();
    expect((await billing.currentPlan(user.id)).key).toBe('free');
  });
});
