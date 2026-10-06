import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { db, orgs } from '@pwamart/db';
import { config } from './config.js';
import { featureColumns, inspect, verifyOrigin } from './inspect.js';
import { sharedHost } from './shared-hosts.js';
import { sendClaimVerified } from './mail.js';

/**
 * Directory imports and the claims that hand them to their owners.
 *
 * saasrow.com publishes its APPROVED listings at /api/v1/products (the same filter
 * its pages use). The importer inspects each listing's website and imports only
 * real, complete PWAs: installable, with a manifest name, an icon and a
 * description. Each becomes a published listing under an unclaimed publisher
 * that lives in a house org until someone proves the domain.
 *
 * A claim is a DNS TXT record at _pwamart.<domain>, or the same token on the site
 * itself (its manifest, /.well-known/pwamart.txt or a meta tag), which is the only
 * way on a shared host like you.vercel.app. The daemon checks pending
 * claims every 15 seconds for the first 10 minutes, then every 30, and gives up
 * after 7 days. DNS is asked of public resolvers, not the box's caching one, so
 * a record added a minute ago is seen.
 */

const SAASROW = () => (process.env.SAASROW_URL || 'https://saasrow.com').replace(/\/$/, '');
const FAST_MS = 15_000;
const SLOW_MS = 30_000;
const FAST_WINDOW_MS = 10 * 60_000;
const CLAIM_TTL_MS = 7 * 86400_000;
const RECHECK_DAYS = 7;

const slugify = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/* ------------------------------------------------------------ house org -- */

let houseOrgId = null;
/** The org imported publishers live in until claimed, owned by a no-login system account. */
export async function houseOrg(sql = db()) {
  if (houseOrgId) return houseOrgId;
  const [user] = await sql`
    insert into users (email, name) values ('unclaimed@pwamart.com', 'Unclaimed listings')
    on conflict (lower(email)) do update set name = users.name returning id`;
  const existing = await orgs.getOrgBySlug(sql, 'pwamart-unclaimed');
  const org = existing ?? (await orgs.createOrg(sql, { name: 'Unclaimed listings', slug: 'pwamart-unclaimed', userId: user.id }));
  houseOrgId = org.id;
  return houseOrgId;
}

/* ---------------------------------------------------------------- import -- */

const CATEGORY = [
  [/developer|devtools|api|code|git|hosting|infrastructure/i, 'developer-tools'],
  [/\bai\b|artificial|machine learning|llm|agent/i, 'ai'],
  [/security|privacy|vpn|password/i, 'security'],
  [/finance|crypto|accounting|payment|invoice|bank/i, 'finance'],
  [/market|sales|crm|business|hr|legal|analytics/i, 'business'],
  [/chat|messag|email|communication|meeting|video call/i, 'communication'],
  [/social|community|forum/i, 'social'],
  [/music|video|media|podcast|stream/i, 'media'],
  [/news|reading|rss|blog|writing/i, 'news'],
  [/education|learn|course|school/i, 'education'],
  [/health|fitness|medical|wellness/i, 'health'],
  [/design|photo|image|graphic/i, 'design'],
  [/shop|ecommerce|store|retail/i, 'shopping'],
  [/travel|map|navigation/i, 'travel'],
  [/game/i, 'games'],
  [/productivity|task|note|calendar|project management|document/i, 'productivity'],
  [/utilit|tool|convert/i, 'utilities'],
];
export function mapCategory(...hints) {
  const text = hints.flat().filter(Boolean).join(' ');
  return CATEGORY.find(([re]) => re.test(text))?.[1] ?? 'productivity';
}

/** Is this inspection a complete PWA worth listing? */
export function qualifies(report, product = {}) {
  if (!report?.installable || !report.manifest) return { ok: false, why: 'not_installable' };
  const m = report.manifest;
  const missing = [];
  if (!(m.name || m.short_name)) missing.push('name');
  if (!report.app.icon) missing.push('icon');
  if (!(m.description || report.app.description || product.description)) missing.push('description');
  return missing.length ? { ok: false, why: 'incomplete', detail: `missing ${missing.join(', ')}` } : { ok: true };
}

async function uniquePublisherSlug(sql, base) {
  let slug = slugify(base) || 'publisher';
  if (slug.length < 2) slug = `${slug}-apps`;
  for (let i = 0; i < 50; i++) {
    const candidate = i ? `${slug}-${i + 1}` : slug;
    const [hit] = await sql`select 1 from publishers where slug = ${candidate}`;
    if (!hit) return candidate;
  }
  return `${slug}-${randomBytes(3).toString('hex')}`;
}
const uniqueAppSlug = async (sql, base) => {
  let slug = slugify(base) || 'app';
  if (slug.length < 2) slug = `${slug}-app`;
  for (let i = 0; i < 50; i++) {
    const candidate = i ? `${slug}-${i + 1}` : slug;
    const [hit] = await sql`select 1 from apps where slug = ${candidate}`;
    if (!hit) return candidate;
  }
  return `${slug}-${randomBytes(3).toString('hex')}`;
};

const firstSentence = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  const cut = t.match(/^(.{20,138}?[.!?])(\s|$)/);
  return (cut ? cut[1] : t).slice(0, 140) || null;
};

/** Import one directory product. Returns the result recorded in import_seen. */
export async function importProduct(product, { source = 'saasrow', inspectFn = inspect, sql = db() } = {}) {
  let origin;
  try {
    const u = new URL(product.website);
    if (u.protocol !== 'https:' && !inspectFn.allowHttp) return { result: 'skip', detail: 'not https' };
    origin = u.origin;
  } catch {
    return { result: 'skip', detail: 'no website' };
  }
  const record = async (result, detail = null) => {
    await sql`
      insert into import_seen (origin, source, source_ref, result, detail) values (${origin}, ${source}, ${String(product.id)}, ${result}, ${detail})
      on conflict (origin) do update set result = excluded.result, detail = excluded.detail, source_ref = excluded.source_ref, checked_at = now()`;
    return { result, detail, origin };
  };
  const [exists] = await sql`select slug from apps where origin = ${origin} and status <> 'removed' limit 1`;
  if (exists) return record('exists', exists.slug);

  let report;
  try {
    report = await inspectFn(product.website);
  } catch (err) {
    return record('error', String(err.message).slice(0, 200));
  }
  const q = qualifies(report, product);
  if (!q.ok) return record(q.why, q.detail ?? null);

  const sqlj = sql;
  const host = new URL(report.origin).hostname.replace(/^www\./, '');
  const orgId = await houseOrg(sql);
  const app = report.app;
  return sql.begin(async (tx) => {
    let [pub] = await tx`select id, slug from publishers where source = ${source} and claim_domain = ${host} limit 1`;
    if (!pub) {
      [pub] = await tx`
        insert into publishers (org_id, slug, name, website, bio, claimable, claim_domain, source, source_ref)
        values (${orgId}, ${await uniquePublisherSlug(tx, host.split('.')[0] === 'app' ? host.split('.')[1] : host.split('.')[0])},
                ${String(product.name || app.name).slice(0, 80)}, ${report.origin},
                ${`Imported from ${source}. Unclaimed: the owner of ${host} can claim it.`},
                true, ${host}, ${source}, ${String(product.id)})
        returning id, slug`;
    }
    const slug = await uniqueAppSlug(tx, app.name || product.name);
    await tx`
      insert into apps ${tx({
        publisher_id: pub.id,
        slug,
        name: String(app.name || product.name).slice(0, 80),
        summary: firstSentence(app.description || product.description),
        description: String(app.description || product.description || '').slice(0, 8000),
        url: report.url,
        origin: report.origin,
        start_url: app.startUrl,
        manifest_url: report.manifestUrl,
        manifest_id: app.manifestId,
        manifest: sqlj.json(report.manifest),
        icon_url: app.icon,
        screenshots: sqlj.json(app.screenshots ?? []),
        theme_color: app.themeColor,
        background_color: app.backgroundColor,
        display: app.display,
        category: mapCategory(product.category, product.tags, app.categories),
        tags: (Array.isArray(product.tags) ? product.tags : []).map(slugify).filter(Boolean).slice(0, 10),
        status: 'published',
        verify_token: randomBytes(12).toString('hex'),
        check_report: sqlj.json({ installable: report.installable, score: report.score, checks: report.checks }),
        ...featureColumns(report),
        checked_at: new Date(),
        published_at: new Date(),
        source,
        source_ref: String(product.id),
      })}`;
    await tx`
      insert into import_seen (origin, source, source_ref, result, detail) values (${origin}, ${source}, ${String(product.id)}, 'imported', ${slug})
      on conflict (origin) do update set result = 'imported', detail = excluded.detail, checked_at = now()`;
    return { result: 'imported', detail: slug, origin };
  });
}

/** Every approved saasrow product, paged. */
export async function fetchSaasrow({ fetchImpl = fetch } = {}) {
  const items = [];
  for (let offset = 0; offset < 10_000; ) {
    const res = await fetchImpl(`${SAASROW()}/api/v1/products?limit=100&offset=${offset}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`saasrow ${res.status}`);
    const page = await res.json();
    items.push(...page.data);
    if (page.pagination?.next == null) break;
    offset = page.pagination.next;
  }
  return items;
}

/**
 * One import pass: products whose origin was never seen, or seen (and not
 * imported) more than a week ago. `limit` bounds a pass so the first run over
 * the whole directory spreads across several turns of the daemon.
 */
export async function runSaasrowImport({ limit = 150, concurrency = 4, products, inspectFn, sql = db() } = {}) {
  const all = products ?? (await fetchSaasrow());
  const seen = new Map(
    (await sql`select origin, result, checked_at from import_seen where source = 'saasrow'`).map((r) => [r.origin, r]),
  );
  const due = [];
  for (const p of all) {
    let origin;
    try {
      origin = new URL(p.website).origin;
    } catch {
      continue;
    }
    const s = seen.get(origin);
    if (s && (s.result === 'imported' || s.result === 'exists' || Date.now() - new Date(s.checked_at).getTime() < RECHECK_DAYS * 86400_000)) continue;
    due.push(p);
    if (due.length >= limit) break;
  }
  const tally = {};
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < due.length) {
        const p = due[i++];
        const r = await importProduct(p, { inspectFn, sql }).catch((err) => ({ result: 'error', detail: err.message }));
        tally[r.result] = (tally[r.result] ?? 0) + 1;
      }
    }),
  );
  return { considered: due.length, total: all.length, ...tally };
}

/* ---------------------------------------------------------------- claims -- */

let resolver = new Resolver({ timeout: 5000, tries: 2 });
resolver.setServers(['1.1.1.1', '8.8.8.8']);
let txtLookup = (name) => resolver.resolveTxt(name);
/** Tests swap DNS for a fake. */
export const setTxtLookup = (fn) => {
  txtLookup = fn;
};

let siteProof = verifyOrigin;
/** Tests swap the site checks (manifest, file, meta) for a fake. */
export const setSiteProof = (fn) => {
  siteProof = fn ?? verifyOrigin;
};

export const claimRecord = (claim) => ({
  type: 'TXT',
  name: `_pwamart.${claim.domain}`,
  value: `pwamart-verification=${claim.token}`,
});

/** The proofs on the site itself, which work for any claim (and are all a shared host has). */
export const claimAlternatives = (claim) => [
  { method: 'manifest', how: `Add to your web app manifest: "pwamart": { "verification": "${claim.token}" }` },
  { method: 'well-known', how: `Serve https://${claim.domain}/.well-known/pwamart.txt containing: ${claim.token}` },
  { method: 'meta', how: `Add to the home page head: <meta name="pwamart-verification" content="${claim.token}">` },
];

export function shapeClaim(c, publisher) {
  const age = Date.now() - new Date(c.created_at).getTime();
  return {
    id: c.id,
    publisher: publisher ?? undefined,
    domain: c.domain,
    status: c.status,
    // No DNS record to offer on a shared host: the platform owns that zone.
    record: sharedHost(c.domain) ? null : claimRecord(c),
    alternatives: claimAlternatives(c),
    checks: c.checks,
    last_checked_at: c.last_checked_at,
    next_check_at: c.next_check_at,
    last_result: c.last_result,
    verified_at: c.verified_at,
    interval_seconds: age < FAST_WINDOW_MS ? FAST_MS / 1000 : SLOW_MS / 1000,
    expires_at: new Date(new Date(c.created_at).getTime() + CLAIM_TTL_MS),
  };
}

/** Start (or return the live) claim of a claimable publisher by this user. */
export async function startClaim({ user, publisherSlug, sql = db() }) {
  const [pub] = await sql`select id, slug, name, claimable, claim_domain from publishers where slug = ${publisherSlug}`;
  if (!pub) return { error: 'no such publisher', status: 404 };
  if (!pub.claimable || !pub.claim_domain) return { error: 'this publisher is not open to claims', status: 409 };
  const [live] = await sql`select * from publisher_claims where publisher_id = ${pub.id} and user_id = ${user.id} and status = 'pending'`;
  if (live) return { claim: shapeClaim(live, pub) };
  const [c] = await sql`
    insert into publisher_claims (publisher_id, user_id, domain, token)
    values (${pub.id}, ${user.id}, ${pub.claim_domain}, ${randomBytes(16).toString('hex')}) returning *`;
  return { claim: shapeClaim(c, pub) };
}

/** Check one claim's TXT record now and act on it. */
export async function checkClaim(claim, sql = db()) {
  const record = claimRecord(claim);
  const shared = sharedHost(claim.domain);
  let found = false;
  let result = 'no proof yet';
  let method = 'dns';
  if (!shared) {
    try {
      const rows = (await txtLookup(record.name)).map((r) => r.join('').trim());
      found = rows.includes(record.value);
      result = found ? 'found' : rows.length ? `TXT present but not ours (${rows.length})` : 'no TXT record yet';
    } catch (err) {
      result = err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'no TXT record yet' : `dns: ${err.code ?? err.message}`;
    }
  }
  // The site itself can carry the same token: its manifest, /.well-known/pwamart.txt
  // or a meta tag. The only way on a shared host, whose DNS belongs to the platform.
  if (!found) {
    const origin = `https://${claim.domain}`;
    const site = await siteProof({ origin, url: `${origin}/`, token: claim.token, txt: async () => [] }).catch(() => null);
    if (site) {
      found = true;
      method = site;
      result = `found (${site})`;
    }
  }
  if (!found) {
    const age = Date.now() - new Date(claim.created_at).getTime();
    if (age > CLAIM_TTL_MS) {
      await sql`update publisher_claims set status = 'expired', last_result = ${result}, last_checked_at = now(), checks = checks + 1 where id = ${claim.id}`;
      return { status: 'expired', result };
    }
    const next = age < FAST_WINDOW_MS ? FAST_MS : SLOW_MS;
    await sql`
      update publisher_claims set checks = checks + 1, last_checked_at = now(), last_result = ${result},
        next_check_at = now() + make_interval(secs => ${next / 1000}) where id = ${claim.id}`;
    return { status: 'pending', result };
  }
  // Verified: the publisher, its apps and their domain proof move to the claimant.
  const moved = await sql.begin(async (tx) => {
    const [still] = await tx`select id from publishers where id = ${claim.publisher_id} and claimable for update`;
    if (!still) return null;
    const personal = await orgs.ensurePersonalOrg(tx, { userId: claim.user_id });
    await tx`update publishers set org_id = ${personal.id}, claimable = false, created_by = ${claim.user_id},
             bio = case when bio like 'Imported from %' then null else bio end where id = ${claim.publisher_id}`;
    const apps = await tx`update apps set verified_at = now(), verified_by = ${method}, created_by = ${claim.user_id}
                          where publisher_id = ${claim.publisher_id} returning slug`;
    await tx`update publisher_claims set status = 'verified', verified_at = now(), last_checked_at = now(),
             last_result = 'found', checks = checks + 1 where id = ${claim.id}`;
    await tx`update publisher_claims set status = 'superseded' where publisher_id = ${claim.publisher_id} and status = 'pending'`;
    return apps.length;
  });
  if (moved === null) {
    await sql`update publisher_claims set status = 'superseded', last_result = 'claimed by someone else first' where id = ${claim.id}`;
    return { status: 'superseded', result: 'claimed by someone else first' };
  }
  const [info] = await sql`select u.email, p.name, p.slug from users u, publishers p where u.id = ${claim.user_id} and p.id = ${claim.publisher_id}`;
  sendClaimVerified({ email: info.email, publisher: info.name, apps: moved, url: `${config.siteUrl}/console/publishers` }).catch((err) =>
    console.error(`[claims] mail: ${err.message}`),
  );
  return { status: 'verified', result: 'found', apps: moved };
}

/** Daemon turn: every pending claim whose next check is due. */
export async function runClaimChecks({ sql = db(), max = 50 } = {}) {
  const due = await sql`select * from publisher_claims where status = 'pending' and next_check_at <= now() order by next_check_at limit ${max}`;
  const out = { checked: 0, verified: 0 };
  for (const c of due) {
    const r = await checkClaim(c, sql);
    out.checked++;
    if (r.status === 'verified') out.verified++;
  }
  return out;
}
