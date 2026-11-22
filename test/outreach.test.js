/**
 * Weekly outreach: composing the digest, caps, exclusions, and (against a real
 * Postgres, DATABASE_URL) who gets what, the weekly gap and the opt-out.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';

const o = await import('../apps/web/src/outreach.js');
const SITE = 'https://pwamart.test';

const owner = (over = {}) => ({
  badge: [],
  drafts: [],
  profile: [],
  comments: [],
  credits: 0,
  featured: false,
  stats: { installs: 0, votes: 0, top: null },
  ...over,
});

describe('outreach: compose', () => {
  test('claim only: the claim link per publisher, the reason and the unsubscribe', () => {
    const m = o.composeDigest({
      claim: [{ slug: 'acme', name: 'Acme', domain: 'acme.io', apps: ['Acme Notes'] }],
      siteUrl: SITE,
      unsubUrl: `${SITE}/outreach/unsubscribe?t=x`,
    });
    expect(m.kinds).toEqual(['claim']);
    expect(m.subject).toBe('Acme Notes is listed on pwamart: claim it free');
    expect(m.text).toContain(`${SITE}/console/claim/acme`);
    expect(m.text).toContain('saasrow.com');
    expect(m.text).toContain(`Stop them: ${SITE}/outreach/unsubscribe?t=x`);
  });

  test('several apps pluralise the subject', () => {
    const m = o.claimSection(
      [
        { slug: 'a', name: 'A', domain: 'a.io', apps: ['One', 'Two'] },
        { slug: 'b', name: 'B', domain: 'b.io', apps: ['Three'] },
      ],
      SITE,
    );
    expect(m.subject).toBe('3 apps of yours are listed on pwamart: claim them free');
  });

  test('owner: stats alone never send; a nudge does, with stats as the subject', () => {
    expect(o.composeDigest({ owner: owner({ stats: { installs: 9, votes: 2, top: { name: 'X', installs: 9 } } }), siteUrl: SITE, unsubUrl: 'u' })).toBeNull();
    const m = o.composeDigest({
      owner: owner({
        stats: { installs: 9, votes: 2, top: { name: 'X', installs: 9 } },
        badge: [{ slug: 'x', name: 'X', host: 'x.io' }],
        credits: 1,
      }),
      siteUrl: SITE,
      unsubUrl: 'u',
    });
    expect(m.subject).toBe('Your pwamart week: 9 installs');
    expect(m.kinds.sort()).toEqual(['badge', 'credits']);
    expect(m.text).toContain(`<a href="${SITE}/apps/x?ref=badge"><img src="${SITE}/apps/x/badge.svg"`);
    expect(m.text).toContain(`${SITE}/console/feature`);
    expect(m.text).toContain(`${SITE}/featured`);
  });

  test('a featured owner gets no Featured upsell', () => {
    const m = o.composeDigest({ owner: owner({ featured: true, drafts: [{ slug: 'd', name: 'D' }] }), siteUrl: SITE, unsubUrl: 'u' });
    expect(m.text).not.toContain('/featured');
    expect(m.subject).toBe('1 quick win for your apps on pwamart');
  });

  test('owner with unclaimed listings too gets both in one email', () => {
    const m = o.composeDigest({
      owner: owner({ comments: [{ slug: 'x', name: 'X', count: 2 }] }),
      claim: [{ slug: 'c', name: 'C', domain: 'c.io', apps: [] }],
      siteUrl: SITE,
      unsubUrl: 'u',
    });
    expect(m.kinds).toEqual(['comments', 'claim']);
    expect(m.subject).toBe('New comments on X on pwamart');
    expect(m.text).toContain(`${SITE}/apps/x#comments`);
    expect(m.text).toContain(`${SITE}/console/claim/c`);
  });

  test('caps drop a nudge that was sent enough times; uncapped ones stay', () => {
    const c = o.applyCaps(
      { claim: [{ slug: 'c' }], owner: owner({ badge: [{ slug: 'b' }], credits: 1 }) },
      { claim: o.CAPS.claim, badge: o.CAPS.badge - 1, credits: 99 },
    );
    expect(c.claim).toEqual([]);
    expect(c.owner.badge).toHaveLength(1);
    expect(c.owner.credits).toBe(1);
  });

  test('exclusions: staff, the house account, our domains, junk', () => {
    const opts = { adminEmails: ['boss@x.com'], domains: ['profullstack.com'] };
    expect(o.excluded('boss@x.com', opts)).toBe(true);
    expect(o.excluded('unclaimed@pwamart.com', opts)).toBe(true);
    expect(o.excluded('a@profullstack.com', opts)).toBe(true);
    expect(o.excluded('a@mail.profullstack.com', opts)).toBe(true);
    expect(o.excluded('a@notprofullstack.com', opts)).toBe(false);
    expect(o.excluded('nope', opts)).toBe(true);
    expect(o.excluded('Dev@Acme.io', opts)).toBe(false);
  });
});

const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

d('outreach end to end', () => {
  let db, orgs, sql;
  const run = randomBytes(4).toString('hex');
  const claimant = `claim-${run}@acme.test`;
  const ownerEmail = `owner-${run}@acme.test`;
  const sent = [];
  const sendFn = async (m) => {
    sent.push(m);
    return true;
  };
  const mine = () => sent.filter((m) => m.to === claimant || m.to === ownerEmail);

  beforeAll(async () => {
    process.env.SITE_URL = SITE;
    const dbm = await import('../packages/db/src/index.js');
    db = dbm.db;
    orgs = dbm.orgs;
    sql = db();
    await (await import('../packages/db/src/migrate.js')).migrate({ log: () => {} });
    const { houseOrg } = await import('../apps/web/src/imports.js');
    const house = await houseOrg(sql);
    // An unclaimed import with one published app, and its saasrow contact.
    const [pub] = await sql`
      insert into publishers (org_id, slug, name, website, claimable, claim_domain, source, source_ref)
      values (${house}, ${`acme-${run}`}, 'Acme', 'https://acme.test', true, ${`acme-${run}.test`}, 'saasrow', ${`ref-${run}`}) returning id`;
    await sql`insert into apps (publisher_id, slug, name, url, origin, status, verify_token)
              values (${pub.id}, ${`acme-notes-${run}`}, 'Acme Notes', 'https://acme.test/', 'https://acme.test', 'published', 'tok')`;
    // An owner: one published app without the badge (already checked), one draft, no logo.
    const [u] = await sql`insert into users (email) values (${ownerEmail}) returning id`;
    const org = await orgs.ensurePersonalOrg(sql, { userId: u.id });
    const [p2] = await sql`insert into publishers (org_id, slug, name, bio, created_by) values (${org.id}, ${`own-${run}`}, 'Own', 'We make apps', ${u.id}) returning id`;
    await sql`insert into apps (publisher_id, slug, name, url, origin, status, verify_token, badge_checked_at)
              values (${p2.id}, ${`own-live-${run}`}, 'Own Live', 'https://own.test/', 'https://own.test', 'published', 't', now()),
                     (${p2.id}, ${`own-draft-${run}`}, 'Own Draft', 'https://own.test/d', 'https://own.test', 'draft', 't', null)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from publishers where slug in (${`acme-${run}`}, ${`own-${run}`})`;
    await sql`delete from users where email = ${ownerEmail}`;
    await sql`delete from outreach_sends where email in (${claimant}, ${ownerEmail})`;
    await sql`delete from outreach_recipients where email in (${claimant}, ${ownerEmail})`;
  });

  test('contacts sync fills contact_email from the source ref', async () => {
    const r = await o.setContacts([{ source_ref: `ref-${run}`, email: claimant.toUpperCase() }, { source_ref: 'x', email: 'bad' }], { sql });
    expect(r.updated).toBe(1);
    const [p] = await sql`select contact_email from publishers where slug = ${`acme-${run}`}`;
    expect(p.contact_email).toBe(claimant);
  });

  test('one digest each, the right nudges, List-Unsubscribe set', async () => {
    await o.runOutreach({ sql, batch: 10_000, dry: false, sendFn, siteUrl: SITE });
    const got = Object.fromEntries(mine().map((m) => [m.to, m]));
    expect(Object.keys(got).sort()).toEqual([claimant, ownerEmail].sort());
    expect(got[claimant].text).toContain(`/console/claim/acme-${run}`);
    expect(got[claimant].subject).toBe('Acme Notes is listed on pwamart: claim it free');
    expect(got[ownerEmail].text).toContain(`/apps/own-live-${run}/badge.svg`);
    expect(got[ownerEmail].text).toContain('Own Draft is still a draft');
    expect(got[ownerEmail].text).toContain('Own has no logo');
    expect(got[ownerEmail].headers['List-Unsubscribe']).toMatch(/^<https:\/\/pwamart\.test\/outreach\/unsubscribe\?t=.+>$/);
    expect(got[ownerEmail].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  test('nobody gets a second one inside the week', async () => {
    sent.length = 0;
    await o.runOutreach({ sql, batch: 10_000, dry: false, sendFn, siteUrl: SITE });
    expect(mine()).toHaveLength(0);
  });

  test('after the gap it repeats; an opted-out address never does', async () => {
    await sql`update outreach_sends set sent_at = now() - interval '8 days' where email in (${claimant}, ${ownerEmail})`;
    const [{ token }] = await sql`select token from outreach_recipients where email = ${claimant}`;
    expect((await o.unsubscribe(token, sql)).email).toBe(claimant);
    sent.length = 0;
    await o.runOutreach({ sql, batch: 10_000, dry: false, sendFn, siteUrl: SITE });
    expect(mine().map((m) => m.to)).toEqual([ownerEmail]);
  });

  test('a claimed publisher drops out of the claim campaign', async () => {
    await sql`update publishers set claimable = false where slug = ${`acme-${run}`}`;
    const t = await o.claimTargets(sql);
    expect(t.has(claimant)).toBe(false);
  });
});
