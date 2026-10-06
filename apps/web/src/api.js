import { randomBytes } from 'node:crypto';
import { db, orgs } from '@pwamart/db';
import { createCheckout, paymentsEnabled, settleWebhook, verifyWebhook } from '@pwamart/payments';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import * as auth from './auth.js';
import { categoryCounts, getApp, getPublisher, listApps, recordInstall, reviewsFor, shape } from './catalog.js';
import { CATEGORIES, CATEGORY_NAMES, PLANS, config } from './config.js';
import { InspectError, inspect, verifyOrigin } from './inspect.js';
import { sendLoginLink, sendOrgInvite } from './mail.js';

/**
 * /api/v1: the only thing any client talks to. The store pages, the publisher
 * console, the CLI, the TUI, the desktop app and the MCP servers all use these
 * routes, with a session cookie or a `pm_live_` API key.
 */
export const api = new Hono();

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};

api.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, ...(err.extra ?? {}) }, err.status);
  if (err instanceof InspectError) return c.json({ error: err.message }, 422);
  if (err?.status === 403 && err?.code === 'FORBIDDEN') return c.json({ error: err.message }, 403);
  if (err?.code === '23505') return c.json({ error: 'that name is taken' }, 409);
  if (err?.code === '23514') return c.json({ error: 'a value is not allowed (slugs are a-z, 0-9 and dashes)' }, 400);
  if (err?.code === '22P02') return c.json({ error: 'invalid value' }, 400);
  console.error('[api]', err);
  return c.json({ error: 'internal error' }, 500);
});

async function body(c) {
  try {
    const b = await c.req.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}
const str = (v, max = 500) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
const httpsUrl = (v) => {
  const s = str(v, 2000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ who -- */

export async function currentUser(c) {
  const bearer = c.req.header('authorization');
  const user = bearer ? await auth.userFromApiKey(bearer) : await auth.userFromSession(getCookie(c, config.session.cookie));
  if (user && !user.is_admin && config.adminEmails.includes(user.email.toLowerCase())) {
    await db()`update users set is_admin = true where id = ${user.id}`;
    user.is_admin = true;
  }
  return user;
}

async function requireUser(c) {
  const u = await currentUser(c);
  if (!u) fail(401, 'sign in first');
  return u;
}

/* ---------------------------------------------------------------- plans -- */

/** The account's plan right now. A lapsed paid plan reads as free. */
export async function planFor(userId) {
  const [row] = await db()`
    select u.is_admin, p.plan, p.paid_through from users u
    left join account_plans p on p.user_id = u.id and p.paid_through > now()
    where u.id = ${userId}`;
  // Staff (the house account that lists our own apps) is never limited.
  if (row?.is_admin) return { key: 'unlimited', ...PLANS.unlimited, paid_through: null, staff: true };
  const key = row?.plan ?? 'free';
  return { key, ...PLANS[key], paid_through: row?.paid_through ?? null };
}

/** Publishers and apps across every org this account created. */
export async function usageFor(userId) {
  const [u] = await db()`
    select
      (select count(*) from publishers p join organizations o on o.id = p.org_id where o.created_by = ${userId})::int as publishers,
      (select count(*) from apps a join publishers p on p.id = a.publisher_id join organizations o on o.id = p.org_id
        where o.created_by = ${userId} and a.status <> 'removed')::int as apps`;
  return u;
}

/** Limits are charged to the account that created the org the thing lives in. */
async function assertRoom(orgId, what) {
  const [o] = await db()`select created_by from organizations where id = ${orgId}`;
  const plan = await planFor(o.created_by);
  const usage = await usageFor(o.created_by);
  const limit = plan[what];
  if (limit !== null && usage[what] >= limit) {
    const next = what === 'publishers' ? (plan.key === 'free' ? 'Pro ($10/yr) for 10' : 'Unlimited ($199/yr)') : plan.key === 'free' ? 'Pro ($10/yr) for 100' : 'Unlimited ($199/yr)';
    fail(402, `the ${plan.name} plan allows ${limit} ${what}; upgrade to ${next}`, { plan: plan.key, limit, upgrade: '/pricing' });
  }
}

async function requireTeamsPlan(userId) {
  const plan = await planFor(userId);
  if (!plan.teams) fail(402, 'shared orgs, teams and projects are on the Unlimited plan ($199/yr)', { upgrade: '/pricing' });
  return plan;
}

/* --------------------------------------------------------------- access -- */

async function orgRole(orgId, userId, role = 'member') {
  return orgs.requireRole(db(), { orgId, userId, role });
}

async function publisherFor(c, slug, role = 'member') {
  const user = await requireUser(c);
  const [p] = await db()`select * from publishers where slug = ${String(slug).toLowerCase()}`;
  if (!p) fail(404, 'no such publisher');
  if (!user.is_admin) await orgRole(p.org_id, user.id, role).catch(() => fail(404, 'no such publisher'));
  return { user, publisher: p };
}

async function appFor(c, slug) {
  const user = await requireUser(c);
  const row = await getApp(slug, { includeDrafts: true });
  if (!row) fail(404, 'no such app');
  const [p] = await db()`select org_id from publishers where id = ${row.publisher_id}`;
  if (!user.is_admin) await orgRole(p.org_id, user.id, 'member').catch(() => fail(404, 'no such app'));
  return { user, row, orgId: p.org_id };
}

async function personalOrg(user) {
  return orgs.ensurePersonalOrg(db(), { userId: user.id, name: user.email.split('@')[0] });
}

/* -------------------------------------------------------------- sign-in -- */

api.post('/auth/link', async (c) => {
  const { email } = await body(c);
  const e = str(email, 254)?.toLowerCase();
  if (!e || !EMAIL.test(e)) return c.json({ error: 'enter a valid email address' }, 400);
  // Same answer whether or not the address has an account.
  try {
    await sendLoginLink({ email: e, url: await auth.createLoginLink(e) });
  } catch (err) {
    console.error(`[auth] could not send link: ${err?.message ?? err}`);
  }
  return c.json({ ok: true, sent: true });
});

api.post('/auth/signout', async (c) => {
  await auth.endSession(getCookie(c, config.session.cookie));
  c.header('set-cookie', auth.sessionCookie('', { clear: true }));
  return c.json({ ok: true });
});

api.post('/auth/passkey/register/options', async (c) => {
  const user = await requireUser(c);
  return c.json(await auth.passkeyRegistrationOptions(user));
});
api.post('/auth/passkey/register/verify', async (c) => {
  const user = await requireUser(c);
  const { response, challengeId } = await body(c);
  const ok = await auth.verifyPasskeyRegistration({ user, response, challengeId }).catch(() => false);
  return ok ? c.json({ ok: true }) : c.json({ error: 'that passkey could not be saved' }, 400);
});
api.post('/auth/passkey/login/options', async (c) => c.json(await auth.passkeyAuthenticationOptions()));
api.post('/auth/passkey/login/verify', async (c) => {
  const { response, challengeId } = await body(c);
  const s = await auth
    .verifyPasskeyAuthentication({ response, challengeId, userAgent: c.req.header('user-agent') })
    .catch(() => null);
  if (!s) return c.json({ error: 'that passkey did not work; use the email link instead' }, 401);
  c.header('set-cookie', auth.sessionCookie(s.sessionId));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------- account -- */

api.get('/me', async (c) => {
  const user = await requireUser(c);
  await personalOrg(user);
  const [plan, usage, myOrgs, publishers, passkeys] = await Promise.all([
    planFor(user.id),
    usageFor(user.id),
    orgs.listOrgsForUser(db(), user.id),
    db()`select p.slug, p.name, p.verified, p.org_id, o.name as org_name,
                (select count(*) from apps a where a.publisher_id = p.id and a.status <> 'removed')::int as apps
         from publishers p join org_members m on m.org_id = p.org_id join organizations o on o.id = p.org_id
         where m.user_id = ${user.id} order by p.created_at`,
    db()`select count(*)::int as n from passkeys where user_id = ${user.id}`,
  ]);
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, admin: user.is_admin, passkeys: passkeys[0].n },
    plan,
    usage,
    orgs: myOrgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, personal: o.is_personal, role: o.role })),
    publishers,
  });
});

api.get('/keys', async (c) => {
  const user = await requireUser(c);
  return c.json({
    keys: await db()`select id, name, prefix, created_at, last_used_at from api_keys
                     where user_id = ${user.id} and revoked_at is null order by created_at desc`,
  });
});
api.post('/keys', async (c) => {
  const user = await requireUser(c);
  const { name } = await body(c);
  return c.json(await auth.createApiKey({ userId: user.id, name: str(name, 60) ?? 'default' }), 201);
});
api.delete('/keys/:id', async (c) => {
  const user = await requireUser(c);
  await db()`update api_keys set revoked_at = now() where id = ${c.req.param('id')} and user_id = ${user.id}`;
  return c.json({ ok: true });
});

/* ------------------------------------------------------- public catalog -- */

api.get('/categories', async (c) => {
  const counts = await categoryCounts();
  return c.json({ categories: CATEGORIES.map(([slug, name]) => ({ slug, name, apps: counts[slug] ?? 0 })) });
});

api.get('/plans', (c) =>
  c.json({ plans: Object.entries(PLANS).map(([key, p]) => ({ key, ...p })), payments_enabled: paymentsEnabled() }),
);

api.get('/apps', async (c) => {
  const q = c.req.query();
  return c.json(
    await listApps({
      q: q.q,
      category: q.category,
      publisher: q.publisher,
      featured: q.featured === '1' || q.featured === 'true',
      sort: q.sort,
      limit: q.limit,
      offset: q.offset,
    }),
  );
});

api.get('/apps/:slug', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.json({ error: 'no such app' }, 404);
  const [reviews, publisher] = await Promise.all([reviewsFor(row.id), getPublisher(row.publisher_slug)]);
  return c.json({ app: shape(row), publisher, reviews });
});

api.post('/apps/:slug/installs', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.json({ error: 'no such app' }, 404);
  const { method } = await body(c);
  const user = await currentUser(c).catch(() => null);
  const m = await recordInstall(row.id, str(method, 20) ?? 'web', user?.id ?? null);
  return c.json({ ok: true, method: m, start_url: row.start_url ?? row.url, manifest_id: row.manifest_id });
});

api.get('/apps/:slug/reviews', async (c) => {
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.json({ error: 'no such app' }, 404);
  return c.json({ reviews: await reviewsFor(row.id, 100) });
});

api.post('/apps/:slug/reviews', async (c) => {
  const user = await requireUser(c);
  const row = await getApp(c.req.param('slug'));
  if (!row) return c.json({ error: 'no such app' }, 404);
  const { rating, body: text } = await body(c);
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) return c.json({ error: 'rating is 1 to 5' }, 400);
  await db().begin(async (tx) => {
    const [old] = await tx`select rating from reviews where app_id = ${row.id} and user_id = ${user.id} for update`;
    await tx`insert into reviews (app_id, user_id, rating, body) values (${row.id}, ${user.id}, ${r}, ${str(text, 4000)})
             on conflict (app_id, user_id) do update set rating = excluded.rating, body = excluded.body, updated_at = now()`;
    await tx`update apps set rating_sum = rating_sum + ${r} - ${old?.rating ?? 0},
                             rating_count = rating_count + ${old ? 0 : 1} where id = ${row.id}`;
  });
  return c.json({ ok: true }, 201);
});

api.get('/publishers/:slug', async (c) => {
  const p = await getPublisher(c.req.param('slug'));
  if (!p) return c.json({ error: 'no such publisher' }, 404);
  return c.json({ publisher: p, ...(await listApps({ publisher: p.slug, limit: 100, sort: 'top' })) });
});

/** Grade any URL's installability. Signed in, so the inspector is not an open proxy. */
api.post('/inspect', async (c) => {
  await requireUser(c);
  const { url } = await body(c);
  if (!str(url)) return c.json({ error: 'url is required' }, 400);
  const r = await inspect(url);
  return c.json({ ...r, manifest: undefined });
});

/* ----------------------------------------------------------- publishers -- */

api.post('/publishers', async (c) => {
  const user = await requireUser(c);
  const b = await body(c);
  const name = str(b.name, 80);
  if (!name) return c.json({ error: 'name is required' }, 400);
  let orgId = b.org ? String(b.org) : (await personalOrg(user)).id;
  if (b.org) {
    const [o] = await db()`select id from organizations where id::text = ${orgId} or slug = ${orgId}`;
    if (!o) fail(404, 'no such org');
    orgId = o.id;
    await orgRole(orgId, user.id, 'admin');
  }
  await assertRoom(orgId, 'publishers');
  const slug = slugify(b.slug ?? name);
  if (slug.length < 2) return c.json({ error: 'pick a longer name or slug' }, 400);
  const [p] = await db()`
    insert into publishers (org_id, slug, name, website, bio, avatar_url, created_by)
    values (${orgId}, ${slug}, ${name}, ${httpsUrl(b.website)}, ${str(b.bio, 1000)}, ${httpsUrl(b.avatar_url)}, ${user.id})
    returning slug, name, website, bio, avatar_url, verified, org_id`;
  return c.json({ publisher: p }, 201);
});

api.patch('/publishers/:slug', async (c) => {
  const { publisher } = await publisherFor(c, c.req.param('slug'), 'admin');
  const b = await body(c);
  const [p] = await db()`
    update publishers set
      name = coalesce(${str(b.name, 80)}, name),
      website = coalesce(${httpsUrl(b.website)}, website),
      bio = coalesce(${str(b.bio, 1000)}, bio),
      avatar_url = coalesce(${httpsUrl(b.avatar_url)}, avatar_url)
    where id = ${publisher.id}
    returning slug, name, website, bio, avatar_url, verified`;
  return c.json({ publisher: p });
});

api.delete('/publishers/:slug', async (c) => {
  const { publisher } = await publisherFor(c, c.req.param('slug'), 'owner');
  await db()`delete from publishers where id = ${publisher.id}`;
  return c.json({ ok: true });
});

/* ---------------------------------------------------------- my apps -- */

api.get('/me/apps', async (c) => {
  const user = await requireUser(c);
  const rows = await db()`
    select a.slug from apps a join publishers p on p.id = a.publisher_id
    join org_members m on m.org_id = p.org_id
    where m.user_id = ${user.id} and a.status <> 'removed' order by a.updated_at desc`;
  const apps = [];
  for (const r of rows) {
    const row = await getApp(r.slug, { includeDrafts: true });
    apps.push({ ...shape(row), verify_token: row.verify_token });
  }
  return c.json({ apps });
});

/** Inspection -> app columns. jsonb values go through sql.json: a bare JS array would bind as a Postgres array. */
function fromReport(r) {
  const sql = db();
  return {
    origin: r.origin,
    start_url: r.app.startUrl,
    manifest_url: r.manifestUrl,
    manifest_id: r.app.manifestId,
    manifest: r.manifest ? sql.json(r.manifest) : null,
    icon_url: r.app.icon,
    screenshots: sql.json(r.app.screenshots ?? []),
    theme_color: r.app.themeColor,
    background_color: r.app.backgroundColor,
    display: r.app.display,
    check_report: sql.json({ installable: r.installable, score: r.score, checks: r.checks }),
  };
}

/** Submit a URL. It is inspected now; the listing starts as a draft until the origin is verified. */
api.post('/apps', async (c) => {
  const b = await body(c);
  if (!b.publisher) return c.json({ error: 'publisher is required (its slug)' }, 400);
  const { user, publisher } = await publisherFor(c, b.publisher, 'member');
  const url = str(b.url, 2000);
  if (!url) return c.json({ error: 'url is required' }, 400);
  await assertRoom(publisher.org_id, 'apps');
  const r = await inspect(url);
  // Default slug: the listing name; a generic or tiny one falls back to the host's first label.
  let slug = slugify(b.slug ?? r.app.name);
  if (!b.slug && (slug.length < 3 || ['app', 'pwa', 'web', 'home', 'index'].includes(slug)))
    slug = slugify(new URL(r.origin).hostname.replace(/^www\./, '').split('.')[0]);
  if (slug.length < 2) return c.json({ error: 'pick a slug' }, 400);
  const category = CATEGORY_NAMES[b.category] ? b.category : guessCategory(r.app.categories);
  let projectId = null;
  if (b.project) {
    const [pr] = await db()`select id from projects where org_id = ${publisher.org_id} and (id::text = ${String(b.project)} or slug = ${String(b.project)})`;
    if (!pr) fail(404, 'no such project in this org');
    projectId = pr.id;
  }
  const f = fromReport(r);
  const token = randomBytes(12).toString('hex');
  // An origin someone already proved for another of this org's apps counts here too.
  const [prior] = await db()`
    select a.verified_by from apps a join publishers p on p.id = a.publisher_id
    where p.org_id = ${publisher.org_id} and a.origin = ${f.origin} and a.verified_at is not null limit 1`;
  const [row] = await db()`
    insert into apps ${db()({
      publisher_id: publisher.id,
      project_id: projectId,
      slug,
      name: str(b.name, 80) ?? r.app.name.slice(0, 80),
      summary: str(b.summary, 140) ?? r.app.description?.slice(0, 140) ?? null,
      description: str(b.description, 8000) ?? r.app.description ?? null,
      url: r.url,
      category,
      tags: Array.isArray(b.tags) ? b.tags.map((t) => slugify(t)).filter(Boolean).slice(0, 10) : [],
      verify_token: token,
      verified_at: prior ? new Date() : null,
      verified_by: prior?.verified_by ?? null,
      checked_at: new Date(),
      created_by: user.id,
      ...f,
    })}
    returning slug`;
  const fresh = await getApp(row.slug, { includeDrafts: true });
  return c.json({ app: { ...shape(fresh), verify_token: token }, verify: verifyHelp(fresh) }, 201);
});

function guessCategory(cats = []) {
  const map = { productivity: 'productivity', developer: 'developer-tools', developer_tools: 'developer-tools', social: 'social',
    music: 'media', entertainment: 'media', news: 'news', books: 'news', finance: 'finance', business: 'business',
    education: 'education', health: 'health', fitness: 'health', lifestyle: 'lifestyle', shopping: 'shopping',
    travel: 'travel', navigation: 'travel', games: 'games', utilities: 'utilities', security: 'security',
    photo: 'design', graphics: 'design', design: 'design' };
  for (const c of cats) {
    const k = String(c).toLowerCase().replace(/[\s-]+/g, '_');
    if (map[k]) return map[k];
  }
  return 'productivity';
}

export function verifyHelp(row) {
  const host = new URL(row.origin).hostname;
  return {
    token: row.verify_token,
    verified: Boolean(row.verified_at ?? row.verified),
    options: [
      { method: 'well-known', how: `Serve ${row.origin}/.well-known/pwamart.txt containing: ${row.verify_token}` },
      { method: 'meta', how: `Add to the page head: <meta name="pwamart-verification" content="${row.verify_token}">` },
      { method: 'dns', how: `DNS TXT record _pwamart.${host} = pwamart-verification=${row.verify_token}` },
    ],
  };
}

api.get('/apps/:slug/manage', async (c) => {
  const { row } = await appFor(c, c.req.param('slug'));
  return c.json({ app: { ...shape(row), verify_token: row.verify_token }, verify: verifyHelp(row) });
});

api.patch('/apps/:slug', async (c) => {
  const { row, orgId } = await appFor(c, c.req.param('slug'));
  const b = await body(c);
  let projectId = row.project_id;
  if (b.project !== undefined) {
    projectId = null;
    if (b.project) {
      const [pr] = await db()`select id from projects where org_id = ${orgId} and (id::text = ${String(b.project)} or slug = ${String(b.project)})`;
      if (!pr) fail(404, 'no such project in this org');
      projectId = pr.id;
    }
  }
  await db()`
    update apps set
      name = coalesce(${str(b.name, 80)}, name),
      summary = coalesce(${str(b.summary, 140)}, summary),
      description = coalesce(${str(b.description, 8000)}, description),
      category = coalesce(${CATEGORY_NAMES[b.category] ? b.category : null}, category),
      tags = coalesce(${Array.isArray(b.tags) ? b.tags.map((t) => slugify(t)).filter(Boolean).slice(0, 10) : null}, tags),
      project_id = ${projectId},
      updated_at = now()
    where id = ${row.id}`;
  return c.json({ app: shape(await getApp(row.slug, { includeDrafts: true })) });
});

/** Re-read the manifest: name, icons and screenshots follow the app's own manifest. */
api.post('/apps/:slug/refresh', async (c) => {
  const { row } = await appFor(c, c.req.param('slug'));
  const r = await inspect(row.url);
  if (r.origin !== row.origin) fail(409, `the URL now lands on ${r.origin}; submit it as a new app`);
  const f = fromReport(r);
  await db()`update apps set ${db()(f)}, checked_at = now(), updated_at = now() where id = ${row.id}`;
  return c.json({ app: shape(await getApp(row.slug, { includeDrafts: true })) });
});

api.post('/apps/:slug/verify', async (c) => {
  const { row } = await appFor(c, c.req.param('slug'));
  if (row.verified) return c.json({ verified: true, method: 'already' });
  const method = await verifyOrigin({ origin: row.origin, url: row.url, token: row.verify_token });
  if (!method) return c.json({ verified: false, error: 'the token was not found yet', verify: verifyHelp(row) }, 409);
  await db()`update apps set verified_at = now(), verified_by = ${method} where id = ${row.id}`;
  return c.json({ verified: true, method });
});

api.post('/apps/:slug/:action{publish|unlist|unpublish}', async (c) => {
  const { row } = await appFor(c, c.req.param('slug'));
  const action = c.req.param('action');
  if (action === 'publish') {
    if (!row.verified) fail(409, 'verify that you own the origin first', { verify: verifyHelp(row) });
    if (row.check_report && row.check_report.installable === false)
      fail(409, 'the app is not installable yet; fix the required checks and refresh', { checks: row.check_report.checks });
  }
  const status = { publish: 'published', unlist: 'unlisted', unpublish: 'draft' }[action];
  await db()`update apps set status = ${status}::app_status, updated_at = now(),
             published_at = case when ${status} = 'published' then coalesce(published_at, now()) else published_at end
             where id = ${row.id}`;
  return c.json({ ok: true, status });
});

api.delete('/apps/:slug', async (c) => {
  const { row } = await appFor(c, c.req.param('slug'));
  // Removed rather than deleted: the slug stays taken so nobody can squat a known name.
  await db()`update apps set status = 'removed', updated_at = now() where id = ${row.id}`;
  return c.json({ ok: true });
});

/* -------------------------------------------- orgs, teams and projects -- */

api.get('/orgs', async (c) => {
  const user = await requireUser(c);
  return c.json({ orgs: await orgs.listOrgsForUser(db(), user.id) });
});

api.post('/orgs', async (c) => {
  const user = await requireUser(c);
  await requireTeamsPlan(user.id);
  const { name, slug } = await body(c);
  if (!str(name, 80)) return c.json({ error: 'name is required' }, 400);
  return c.json({ org: await orgs.createOrg(db(), { name: str(name, 80), slug: str(slug, 60), userId: user.id }) }, 201);
});

async function orgFor(c, ref, role = 'member') {
  const user = await requireUser(c);
  const [o] = await db()`select * from organizations where id::text = ${String(ref)} or slug = ${String(ref)}`;
  if (!o) fail(404, 'no such org');
  await orgRole(o.id, user.id, role).catch(() => fail(404, 'no such org'));
  return { user, org: o };
}

api.get('/orgs/:org', async (c) => {
  const { org } = await orgFor(c, c.req.param('org'));
  const sql = db();
  const [members, teams, projects, publishers, invites] = await Promise.all([
    sql`select u.email, m.role, m.created_at from org_members m join users u on u.id = m.user_id where m.org_id = ${org.id} order by m.created_at`,
    orgs.listTeams(sql, org.id),
    sql`select p.slug, p.name, (select count(*) from apps a where a.project_id = p.id and a.status <> 'removed')::int as apps
        from projects p where p.org_id = ${org.id} order by p.name`,
    sql`select slug, name, verified from publishers where org_id = ${org.id} order by name`,
    sql`select email, role, created_at from org_invites where org_id = ${org.id} and accepted_at is null and revoked_at is null`,
  ]);
  return c.json({ org, members, teams, projects, publishers, invites });
});

api.post('/orgs/:org/invites', async (c) => {
  const { user, org } = await orgFor(c, c.req.param('org'), 'admin');
  await requireTeamsPlan(org.created_by);
  const { email, role = 'member' } = await body(c);
  const e = str(email, 254)?.toLowerCase();
  if (!e || !EMAIL.test(e)) return c.json({ error: 'enter a valid email address' }, 400);
  if (!['member', 'admin'].includes(role)) return c.json({ error: 'role is member or admin' }, 400);
  await orgs.inviteToOrg(db(), { orgId: org.id, email: e, role, invitedBy: user.id });
  await sendOrgInvite({ email: e, orgName: org.name, url: await auth.createLoginLink(e) }).catch((err) =>
    console.error(`[invite] ${err.message}`),
  );
  return c.json({ ok: true }, 201);
});

api.post('/orgs/:org/teams', async (c) => {
  const { user, org } = await orgFor(c, c.req.param('org'), 'admin');
  await requireTeamsPlan(org.created_by);
  const { name } = await body(c);
  if (!str(name, 80)) return c.json({ error: 'name is required' }, 400);
  return c.json({ team: await orgs.createTeam(db(), { orgId: org.id, name: str(name, 80), userId: user.id }) }, 201);
});

api.post('/orgs/:org/projects', async (c) => {
  const { user, org } = await orgFor(c, c.req.param('org'), 'admin');
  await requireTeamsPlan(org.created_by);
  const { name, slug } = await body(c);
  if (!str(name, 80)) return c.json({ error: 'name is required' }, 400);
  const [p] = await db()`insert into projects (org_id, slug, name, created_by)
    values (${org.id}, ${slugify(slug ?? name)}, ${str(name, 80)}, ${user.id}) returning slug, name`;
  return c.json({ project: p }, 201);
});

/* --------------------------------------------------------------- billing -- */

api.get('/billing', async (c) => {
  const user = await requireUser(c);
  const [plan, usage, payments] = await Promise.all([
    planFor(user.id),
    usageFor(user.id),
    db()`select amount_cents, status, created_at from payments where user_id = ${user.id} order by created_at desc limit 24`,
  ]);
  return c.json({ plan, usage, payments, payments_enabled: paymentsEnabled() });
});

api.post('/billing/checkout', async (c) => {
  const user = await requireUser(c);
  const { plan } = await body(c);
  if (!['pro', 'unlimited'].includes(plan)) return c.json({ error: 'plan is pro or unlimited' }, 400);
  if (!paymentsEnabled()) return c.json({ error: 'payments are not switched on yet' }, 503);
  const p = PLANS[plan];
  const { checkoutUrl } = await createCheckout({
    user,
    amountCents: p.priceCents,
    description: `pwamart ${p.name}: 1 year`,
    metadata: { user_id: user.id, plan, kind: 'year' },
    blockchain: config.coinpay.defaultChain,
    paymentMethod: 'both',
    successUrl: `${config.siteUrl}/console/billing?paid=1`,
    cancelUrl: `${config.siteUrl}/console/billing`,
  });
  return c.json({ checkout_url: checkoutUrl });
});

/**
 * Mounted outside /api/v1 at /webhooks/coinpay. A settled payment adds one year
 * of its plan. Buying unlimited while on pro switches to unlimited from today and
 * keeps whichever end date is later.
 */
export async function coinpayWebhook(c) {
  const raw = await c.req.text();
  const ok = verifyWebhook({ rawBody: raw, signatureHeader: c.req.header('x-coinpay-signature') ?? c.req.header('coinpay-signature') });
  if (!ok) return c.json({ error: 'bad signature' }, 401);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad json' }, 400);
  }
  const result = await settleWebhook(payload, {
    grant: async (tx, { meta, payment }) => {
      if (!meta.user_id || !payment || !PLANS[meta.plan] || meta.plan === 'free') return null;
      // What we charged decides the plan, not what the payload claims.
      if (payment.amount_cents < PLANS[meta.plan].priceCents) return null;
      const [fresh] = await tx`insert into plan_grants (payment_id, user_id, plan) values (${payment.id}, ${meta.user_id}, ${meta.plan})
                               on conflict (payment_id) do nothing returning payment_id`;
      if (!fresh) return { already: true };
      const [row] = await tx`
        insert into account_plans (user_id, plan, paid_through) values (${meta.user_id}, ${meta.plan}, now() + interval '1 year')
        on conflict (user_id) do update set
          plan = case when account_plans.plan = 'unlimited' and account_plans.paid_through > now() then 'unlimited' else excluded.plan end,
          paid_through = case when account_plans.plan = excluded.plan
                              then greatest(account_plans.paid_through, now()) + interval '1 year'
                              else greatest(account_plans.paid_through, now() + interval '1 year') end
        returning plan, paid_through`;
      return row;
    },
  }).catch((err) => ({ error: err.message }));
  return c.json({ ok: true, result });
}

/* ----------------------------------------------------------------- admin -- */

async function requireAdmin(c) {
  const user = await requireUser(c);
  if (!user.is_admin) fail(404, 'not found');
  return user;
}

api.post('/admin/apps/:slug', async (c) => {
  await requireAdmin(c);
  const row = await getApp(c.req.param('slug'), { includeDrafts: true });
  if (!row) fail(404, 'no such app');
  const b = await body(c);
  if (b.featured !== undefined) await db()`update apps set featured = ${Boolean(b.featured)} where id = ${row.id}`;
  if (b.verified) await db()`update apps set verified_at = coalesce(verified_at, now()), verified_by = coalesce(verified_by, 'staff') where id = ${row.id}`;
  if (b.status && ['draft', 'published', 'unlisted', 'removed'].includes(b.status))
    await db()`update apps set status = ${b.status}::app_status, published_at = case when ${b.status} = 'published' then coalesce(published_at, now()) else published_at end where id = ${row.id}`;
  return c.json({ app: shape(await getApp(row.slug, { includeDrafts: true })) });
});

api.post('/admin/publishers/:slug', async (c) => {
  await requireAdmin(c);
  const { verified } = await body(c);
  const [p] = await db()`update publishers set verified = ${Boolean(verified)} where slug = ${c.req.param('slug')} returning slug, verified`;
  if (!p) fail(404, 'no such publisher');
  return c.json({ publisher: p });
});
