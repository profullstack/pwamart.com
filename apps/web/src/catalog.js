import { db } from '@pwamart/db';
import { CATEGORY_NAMES } from './config.js';

/**
 * Reading the store: the queries the API, the server-rendered pages and the
 * hosted MCP endpoint all share, so a listing looks the same on every surface.
 */

const PUBLIC_FIELDS = (sql) => sql`
  a.id, a.slug, a.name, a.summary, a.description, a.url, a.origin, a.start_url, a.manifest_id,
  a.manifest_url, a.icon_url, a.screenshots, a.theme_color, a.background_color, a.display,
  a.category, a.tags, a.status, a.featured, a.installs, a.rating_count,
  case when a.rating_count > 0 then round(a.rating_sum::numeric / a.rating_count, 1) else null end as rating,
  a.verified_at is not null as verified, a.check_report, a.checked_at, a.published_at, a.updated_at,
  p.slug as publisher_slug, p.name as publisher_name, p.verified as publisher_verified`;

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
    publisher: { slug: row.publisher_slug, name: row.publisher_name, verified: row.publisher_verified },
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

/** Published apps, searchable. `q` is websearch syntax, so raw input never errors. */
export async function listApps({ q, category, publisher, featured, sort = 'top', limit = 24, offset = 0 } = {}) {
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
    select slug, name, website, bio, avatar_url, verified, created_at from publishers where slug = ${String(slug).toLowerCase()}`;
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
