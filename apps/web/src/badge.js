import { db } from '@pwamart/db';
import { safeFetch } from './inspect.js';

/**
 * The embeddable "Get it on pwamart" badge, live (rating + installs), and the
 * backlink check behind it. Same shape as built.indie's badge:
 *
 *   /apps/<slug>/badge.svg       one listing's badge (?theme=light)
 *   /for.svg?site=<homepage>     the badge for whatever listing that site is, so
 *                                one snippet works across many sites (the shared
 *                                Profullstack footer); an unlisted site gets
 *                                "List your PWA free" instead
 *   /for?site=<homepage>         302 to the listing (?ref=badge), or to submit
 *
 * A listing whose homepage links back (to /apps/<slug> or /for) is
 * badge-verified: its page shows the ✓ and its website link is followed. The
 * daemon re-checks published listings; owners can check at once (API/CLI/MCP).
 */

export const BADGE_W = 200;
export const BADGE_H = 44;
export const SQUARE_BADGE_SIZE = 128;
export const PWAMART_OPENICON_URL = 'https://logicsrc.com/openicon/set/hq/svg/pwamart.svg';

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The bare host (with any non-default port) a site URL is about: no scheme, no www, lower case. null when it is not a URL. */
export function siteHost(site) {
  const s = String(site ?? '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.host.replace(/^www\./, '').toLowerCase() || null;  // host: a non-default port is part of the site
  } catch {
    return null;
  }
}

/** 1234 -> "1.2k", 1500000 -> "1.5M". */
export function compact(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

const THEMES = {
  dark: { bg: '#000', stroke: '#a6a6a6', fg: '#fff', sub: '#c9c9c9', rule: '#333' },
  light: { bg: '#fff', stroke: '#16211d', fg: '#16211d', sub: '#4d5a55', rule: '#dfe3e0' },
};
export const theme = (v) => (v === 'light' ? 'light' : 'dark');

// The pwamart mark from /badges/get-it-on-pwamart.svg, 26px, placed at (x, y).
const mark = (x, y) => `<g transform="translate(${x} ${y})">
<rect width="26" height="26" rx="6.2" fill="#16211d"/>
<ellipse cx="13" cy="13" rx="11" ry="4.3" transform="rotate(-28 13 13)" fill="none" stroke="#f6f4ed" stroke-opacity=".32" stroke-width=".8"/>
<rect x="6.5" y="6.5" width="5.7" height="5.7" rx="1.6" fill="#f6f4ed"/>
<rect x="6.5" y="13.8" width="5.7" height="5.7" rx="1.6" fill="#f6f4ed"/>
<rect x="13.8" y="13.8" width="5.7" height="5.7" rx="1.6" fill="#f6f4ed"/>
<rect x="13.8" y="6.5" width="5.7" height="5.7" rx="2.85" fill="#e2582f"/>
<path d="M16.65 7.9v2.9M15.2 9.35h2.9" stroke="#16211d" stroke-width=".95" stroke-linecap="round"/>
</g>`;

const SANS = "-apple-system, 'SF Pro Text', 'Helvetica Neue', Roboto, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function frame(t, label, top, right = '') {
  const c = THEMES[t];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE_W}" height="${BADGE_H}" viewBox="0 0 ${BADGE_W} ${BADGE_H}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<rect x=".5" y=".5" width="${BADGE_W - 1}" height="${BADGE_H - 1}" rx="8" fill="${c.bg}" stroke="${c.stroke}"/>
${mark(9, 9)}
<text x="43" y="18" fill="${c.sub}" font-family="${SANS}" font-size="7.6" letter-spacing=".55">${esc(top)}</text>
<text x="42.4" y="34" fill="${c.fg}" font-family="${SERIF}" font-size="17.4" letter-spacing="-.2">pwamart<tspan fill="#e2582f">.</tspan></text>
${right}
</svg>`;
}

/** A listing's badge: rating (or NEW) and installs on the right. */
export function badgeSvg(app, t = 'dark') {
  const c = THEMES[theme(t)];
  const rated = app.rating !== null && app.rating !== undefined && Number(app.rating_count) > 0;
  const rating = rated ? `★ ${Number(app.rating).toFixed(1)}` : 'NEW';
  const installs = `${compact(app.installs)} install${Number(app.installs) === 1 ? '' : 's'}`;
  const label = `Get ${app.name} on pwamart${rated ? `, rated ${Number(app.rating).toFixed(1)}` : ''}, ${installs}`;
  const right = `<line x1="145" y1="9" x2="145" y2="35" stroke="${c.rule}"/>
<text x="172.5" y="21" text-anchor="middle" fill="${rated ? '#e2582f' : c.fg}" font-family="${SANS}" font-size="${rated ? 12 : 10}" font-weight="700">${esc(rating)}</text>
<text x="172.5" y="33" text-anchor="middle" fill="${c.sub}" font-family="${SANS}" font-size="7.4">${esc(installs)}</text>`;
  return frame(theme(t), label, 'GET IT ON', right);
}

/** The badge for a site with no listing: an invitation to list it. */
export function listBadgeSvg(t = 'dark') {
  return frame(theme(t), 'List your PWA free on pwamart', 'LIST YOUR PWA FREE ON');
}

/** Copy-paste snippets for one listing, dark and light. */
export function badgeSnippets(app, siteUrl) {
  const page = `${siteUrl}/apps/${app.slug}?ref=badge`;
  const alt = `Get ${app.name} on pwamart`;
  const one = (t) => {
    const src = `${siteUrl}/apps/${app.slug}/badge.svg${t === 'light' ? '?theme=light' : ''}`;
    return {
      image: src,
      html: `<a href="${page}"><img src="${src}" alt="${esc(alt)}" width="${BADGE_W}" height="${BADGE_H}" loading="lazy"></a>`,
      markdown: `[![${alt}](${src})](${page})`,
    };
  };
  const squareImage = `${siteUrl}/apps/${app.slug}/icon-badge.svg`;
  const squareAlt = `Get ${app.name} on pwamart`;
  const square = {
    image: squareImage,
    html: `<a href="${page}"><img src="${squareImage}" alt="${esc(squareAlt)}" width="${SQUARE_BADGE_SIZE}" height="${SQUARE_BADGE_SIZE}" loading="lazy"></a>`,
    markdown: `[![${squareAlt}](${squareImage})](${page})`,
  };
  return { page, alt, dark: one('dark'), light: one('light'), square };
}

/** The by-site snippet (what the shared footer uses): one line that works on any site. */
export function siteSnippet(siteUrl, homepage) {
  const s = encodeURIComponent(homepage);
  return `<a href="${siteUrl}/for?site=${s}"><img src="${siteUrl}/for.svg?site=${s}" alt="Get it on pwamart" width="${BADGE_W}" height="${BADGE_H}" loading="lazy"></a>`;
}

/* ------------------------------------------------------------- lookups -- */

const FIELDS = (sql) => sql`
  a.id, a.slug, a.name, a.url, a.origin, a.installs, a.rating_count,
  case when a.rating_count > 0 then round(a.rating_sum::numeric / a.rating_count, 1) else null end as rating,
  a.badge_verified_at, a.badge_checked_at`;

/**
 * The published listing for a site (any page of it): an app on that host, the
 * one whose URL is the homepage first, then the most installed. `www.` is the
 * same site; a site whose web app lives at `app.<host>` (moshcode.sh ->
 * app.moshcode.sh) gets that listing when the host itself has none.
 */
export async function appBySite(site) {
  const host = siteHost(site);
  if (!host) return null;
  const sql = db();
  const [row] = await sql`
    select ${FIELDS(sql)} from apps a
    where a.status = 'published'
      and lower(regexp_replace(regexp_replace(a.origin, '^https?://', ''), '^www\\.', '')) in (${host}, ${`app.${host}`})
    order by (lower(regexp_replace(regexp_replace(a.origin, '^https?://', ''), '^www\\.', '')) = ${host}) desc,
      (lower(regexp_replace(a.url, '^https?://(www\\.)?', '')) in (${host}, ${`${host}/`})) desc, a.installs desc, a.published_at
    limit 1`;
  return row ?? null;
}

export async function appBadgeRow(slug) {
  const sql = db();
  const [row] = await sql`select ${FIELDS(sql)} from apps a where a.slug = ${String(slug).toLowerCase()} and a.status = 'published'`;
  return row ?? null;
}

/* ------------------------------------------------------- backlink check -- */

/** Does this HTML link to the listing (/apps/<slug>) or the by-site badge (/for)? */
export function linksBack(html, slug, siteUrl = 'https://pwamart.com') {
  if (!html) return false;
  const hosts = new Set(['pwamart.com']);
  try {
    hosts.add(new URL(siteUrl).host.replace(/^www\./, ''));
  } catch {}
  const h = [...hosts].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const s = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`href\\s*=\\s*["']?(?:https?:)?//(?:www\\.)?(?:${h})/(?:apps/${s}(?:[/?#"'\\s>]|$)|for(?:\\?|["'\\s>]))`, 'i');
  return re.test(html);
}

/**
 * Fetch the listing's homepage and record whether it links back. Removing the
 * badge un-verifies on the next check, so the followed link follows the badge.
 */
export async function checkBadge(row, { siteUrl, fetchFn = safeFetch } = {}) {
  const urls = [...new Set([row.url, `${row.origin}/`])];
  let found = null;
  for (const u of urls) {
    try {
      const r = await fetchFn(u, { accept: 'text/html' });
      if (r.status < 400 && linksBack(r.text, row.slug, siteUrl)) {
        found = u;
        break;
      }
    } catch {}
  }
  const sql = db();
  const [after] = await sql`
    update apps set
      badge_verified_at = ${found ? sql`coalesce(badge_verified_at, now())` : null},
      badge_checked_at = now()
    where id = ${row.id}
    returning badge_verified_at, badge_checked_at, publisher_id`;
  // The badge shown and verified: +5 karma to the listing's owner, once per listing.
  if (found && after) {
    const { award, ownerOf } = await import('./karma.js');
    const owner = await ownerOf(after.publisher_id).catch(() => null);
    if (owner) await award({ userId: owner, action: 'badge', ref: row.id, appId: row.id }).catch((err) => console.error(`[badge] karma: ${err.message}`));
  }
  return { verified: Boolean(found), found_on: found, looked: urls, verified_at: after?.badge_verified_at ?? null, checked_at: after?.badge_checked_at ?? null };
}

/**
 * The daemon's turn: published listings never checked first, then unverified
 * ones every 6 hours and verified ones daily, a few at a time.
 */
export async function runBadgeChecks({ batch = 6, siteUrl } = {}) {
  const sql = db();
  const due = await sql`
    select id, slug, url, origin from apps
    where status = 'published'
      and (badge_checked_at is null
        or (badge_verified_at is null and badge_checked_at < now() - interval '6 hours')
        or badge_checked_at < now() - interval '24 hours')
    order by badge_checked_at nulls first, published_at
    limit ${batch}`;
  let verified = 0;
  await Promise.all(
    due.map(async (row) => {
      const r = await checkBadge(row, { siteUrl }).catch(() => null);
      if (r?.verified) verified++;
    }),
  );
  return { checked: due.length, verified };
}
