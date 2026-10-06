import { db } from '@pwamart/db';
import { CATEGORY_NAMES } from './config.js';

/**
 * Reading the store: the queries the API, the server-rendered pages and the
 * hosted MCP endpoint all share, so a listing looks the same on every surface.
 */

const PUBLIC_FIELDS = (sql) => sql`
  a.id, a.slug, a.name, a.summary, a.description, a.url, a.origin, a.start_url, a.manifest_id,
  a.manifest_url, a.icon_url, a.screenshots, a.theme_color, a.background_color, a.display,
  a.category, a.tags, a.features, a.offline_reason, a.status, a.featured, a.installs, a.rating_count,
  case when a.rating_count > 0 then round(a.rating_sum::numeric / a.rating_count, 1) else null end as rating,
  a.verified_at is not null as verified, a.check_report, a.checked_at, a.published_at, a.updated_at,
  p.slug as publisher_slug, p.name as publisher_name, p.avatar_url as publisher_avatar, p.verified as publisher_verified, p.claimable as publisher_claimable, p.claim_domain as publisher_claim_domain`;

export function shape(row) {
  if (!row) return null;
  const report = row.check_report ?? {};
  return {
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    description: row.description,
    url: row.url,
    origin: row.origin,
    start_url: row.start_url ?? row.url,
    manifest_id: row.manifest_id,
    manifest_url: row.manifest_url,
    icon: row.icon_url,
    screenshots: row.screenshots ?? [],
    theme_color: row.theme_color,
    background_color: row.background_color,
    display: row.display,
    category: row.category,
    category_name: CATEGORY_NAMES[row.category] ?? row.category,
    tags: row.tags ?? [],
    features: row.features ?? [],
    offline: (row.features ?? []).includes('offline'),
    offline_reason: row.offline_reason ?? null,
    status: row.status,
    featured: row.featured,
    installs: row.installs,
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    rating_count: row.rating_count,
    verified: row.verified,
    installable: report.installable ?? null,
    score: report.score ?? null,
    checks: report.checks ?? [],
    checked_at: row.checked_at,
    published_at: row.published_at,
    updated_at: row.updated_at,
    publisher: { slug: row.publisher_slug, name: row.publisher_name, avatar_url: row.publisher_avatar ?? null, verified: row.publisher_verified, claimable: Boolean(row.publisher_claimable), claim_domain: row.publisher_claim_domain ?? null },
    links: {
      page: `/apps/${row.slug}`,
      ios_profile: `/apps/${row.slug}/install.mobileconfig`,
      cli: `npx -y @profullstack/pwamart install ${row.slug}`,
    },
  };
}

const SORTS = {
  top: (sql) => sql`a.featured desc, a.installs desc, a.published_at desc`,
  new: (sql) => sql`a.published_at desc nulls last`,
  rating: (sql) => sql`(a.rating_sum::numeric / greatest(a.rating_count, 1)) desc, a.rating_count desc`,
  name: (sql) => sql`lower(a.name)`,
};

/** What the inspector can detect about an app, filterable everywhere as `feature=<key>`. */
export const FEATURES = { offline: 'Works offline' };
export const featureKey = (v) => (v && Object.hasOwn(FEATURES, String(v)) ? String(v) : null);

/** Published apps per feature: { offline: 42 }. */
export async function featureCounts() {
  const sql = db();
  const out = {};
  for (const k of Object.keys(FEATURES)) {
    const [r] = await sql`select count(*)::int as n from apps where status = 'published' and features @> array[${k}]::text[]`;
    out[k] = r.n;
  }
  return out;
}

/** Published apps, searchable. `q` is websearch syntax, so raw input never errors. */
export async function listApps({ q, category, publisher, featured, feature, sort = 'top', limit = 24, offset = 0 } = {}) {
  const sql = db();
  const lim = Math.min(Math.max(Number(limit) || 24, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  const query = q ? String(q).slice(0, 200) : null;
  const order = query
    ? sql`ts_rank(to_tsvector('english', coalesce(a.name, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.description, '')), websearch_to_tsquery('english', ${query})) desc, a.installs desc`
    : (SORTS[sort] ?? SORTS.top)(sql);
  const rows = await sql`
    select ${PUBLIC_FIELDS(sql)}, count(*) over () as total
    from apps a join publishers p on p.id = a.publisher_id
    where a.status = 'published'
      ${category ? sql`and a.category = ${category}` : sql``}
      ${publisher ? sql`and p.slug = ${publisher}` : sql``}
      ${featured ? sql`and a.featured` : sql``}
      ${feature ? sql`and a.features @> array[${String(feature)}]::text[]` : sql``}
      ${
        query
          ? sql`and (to_tsvector('english', coalesce(a.name, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.description, ''))
                     @@ websearch_to_tsquery('english', ${query})
                 or a.name ilike ${`%${query.replace(/[%_\\]/g, '\\$&')}%`}
                 or ${query.toLowerCase()} = any(a.tags))`
          : sql``
      }
    order by ${order}
    limit ${lim} offset ${off}`;
  return { total: Number(rows[0]?.total ?? 0), apps: rows.map(shape) };
}

/** One app by slug. Drafts are visible only when `includeDrafts` (the owner's console). */
export async function getApp(slug, { includeDrafts = false } = {}) {
  const sql = db();
  const [row] = await sql`
    select ${PUBLIC_FIELDS(sql)}, a.publisher_id, a.project_id, a.verify_token
    from apps a join publishers p on p.id = a.publisher_id
    where a.slug = ${String(slug).toLowerCase()}
      ${includeDrafts ? sql`and a.status <> 'removed'` : sql`and a.status in ('published', 'unlisted')`}`;
  return row ?? null;
}

export async function getPublisher(slug) {
  const [p] = await db()`
    select slug, name, website, bio, avatar_url, verified, verified_by, verified_domain, claimable, claim_domain, created_at from publishers where slug = ${String(slug).toLowerCase()}`;
  return p ?? null;
}

export async function categoryCounts() {
  const rows = await db()`select category, count(*)::int as n from apps where status = 'published' group by category`;
  return Object.fromEntries(rows.map((r) => [r.category, r.n]));
}

export async function reviewsFor(appId, limit = 20) {
  return db()`
    select r.rating, r.body, r.created_at, split_part(u.email, '@', 1) as author
    from reviews r join users u on u.id = r.user_id
    where r.app_id = ${appId} and r.body is not null
    order by r.updated_at desc limit ${limit}`;
}

export async function recordInstall(appId, method, userId = null) {
  const m = ['web', 'ios', 'android', 'desktop', 'cli', 'tui', 'tron', 'mcp', 'profile', 'open'].includes(method) ? method : 'web';
  const sql = db();
  await sql`insert into app_installs (app_id, method, user_id) values (${appId}, ${m}, ${userId})`;
  if (m !== 'open') await sql`update apps set installs = installs + 1 where id = ${appId}`;
  return m;
}

/**
 * The publisher directory. Only publishers with at least one live app are listed,
 * the same rule the store bar's count uses. `filter`:
 *   claimed   run by someone with an account here (not an unclaimed import)
 *   imported  listed from another directory and not claimed yet
 *   verified  the store has checked who they are
 */
export const PUBLISHER_FILTERS = ['all', 'claimed', 'imported', 'verified'];
export const PUBLISHER_SORTS = ['apps', 'name', 'new'];

export async function listPublishers({ q, filter = 'all', sort = 'apps', limit = 48, offset = 0 } = {}) {
  const sql = db();
  const term = q ? `%${String(q).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : null;
  const where = sql`
    where exists (select 1 from apps a where a.publisher_id = p.id and a.status = 'published')
    ${term ? sql`and (p.name ilike ${term} or p.slug ilike ${term} or p.website ilike ${term})` : sql``}
    ${filter === 'claimed' ? sql`and not p.claimable` : filter === 'imported' ? sql`and p.claimable` : filter === 'verified' ? sql`and p.verified` : sql``}`;
  const order =
    sort === 'name' ? sql`order by lower(p.name)` : sort === 'new' ? sql`order by p.created_at desc` : sql`order by live desc, installs desc, lower(p.name)`;
  const rows = await sql`
    select p.slug, p.name, p.website, p.bio, p.avatar_url, p.verified, p.claimable, p.source, p.created_at,
           (select count(*) from apps a where a.publisher_id = p.id and a.status = 'published')::int as live,
           (select coalesce(sum(a.installs), 0) from apps a where a.publisher_id = p.id and a.status = 'published')::int as installs,
           (select a.icon_url from apps a where a.publisher_id = p.id and a.status = 'published' and a.icon_url is not null
             order by a.installs desc, a.published_at limit 1) as icon_url,
           count(*) over ()::int as total
    from publishers p ${where} ${order}
    limit ${Math.min(Math.max(Number(limit) || 48, 1), 100)} offset ${Math.max(Number(offset) || 0, 0)}`;
  const [counts] = await sql`
    select count(*)::int as "all",
           count(*) filter (where not p.claimable)::int as claimed,
           count(*) filter (where p.claimable)::int as imported,
           count(*) filter (where p.verified)::int as verified
    from publishers p where exists (select 1 from apps a where a.publisher_id = p.id and a.status = 'published')`;
  return {
    total: rows[0]?.total ?? 0,
    counts,
    publishers: rows.map(({ total, icon_url, ...p }) => ({ ...p, icon: icon_url, apps: p.live })),
  };
}
