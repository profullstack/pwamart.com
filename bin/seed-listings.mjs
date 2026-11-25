#!/usr/bin/env bun
/**
 * Staff bulk listing from a JSON file: an array of { name, url, description, tags }.
 * Every item is published in one category under an unclaimed publisher for its
 * domain, whether or not the site is an installable PWA (the report says which
 * are, and which sites could not be read at all).
 *
 *   PWAMART_API_KEY=pm_live_... bun bin/seed-listings.mjs <file.json> --category adult [--dry-run]
 *   PWAMART_URL=https://pwamart.com   (default)
 *
 * The key must belong to a staff account (ADMIN_EMAILS). Re-running is safe: a
 * site that is already listed is reported as `exists` and left alone. To move an
 * existing listing into the category instead:
 *   curl -X POST $PWAMART_URL/api/v1/admin/apps/<slug> -H "authorization: Bearer $PWAMART_API_KEY" \
 *        -H 'content-type: application/json' -d '{"category":"adult"}'
 *
 * Listings in `adult` are shown only to signed-in members, inside that category.
 */
import { readFileSync } from 'node:fs';

const SERVER = (process.env.PWAMART_URL || 'https://pwamart.com').replace(/\/$/, '');
const KEY = process.env.PWAMART_API_KEY;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? '');
};
const category = flag('category');
const dry = args.includes('--dry-run');

if (!file || !category) {
  console.error('usage: PWAMART_API_KEY=pm_live_... bun bin/seed-listings.mjs <file.json> --category <slug> [--dry-run]');
  process.exit(2);
}
if (!KEY && !dry) throw new Error('PWAMART_API_KEY is required (a staff account key)');

const items = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(items)) throw new Error(`${file} must be a JSON array of { name, url, description, tags }`);
const bad = items.filter((i) => !i?.name || !i?.url);
if (bad.length) throw new Error(`${bad.length} item(s) lack a name or url: ${JSON.stringify(bad[0])}`);

if (dry) {
  for (const i of items) console.log(`would list ${i.url} as "${i.name}" in ${category}`);
  console.log(`${items.length} item(s); nothing was sent.`);
  process.exit(0);
}

async function call(method, path, body) {
  const res = await fetch(`${SERVER}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const me = await call('GET', '/me');
if (me.status !== 200) throw new Error(`/me: ${me.data.error ?? me.status}`);
if (!me.data.user.admin) throw new Error('this key does not belong to a staff account');

// One site a call: each is fetched and inspected, which can take a while.
const totals = { published: 0, exists: 0, skip: 0, error: 0, no_manifest: 0 };
for (const item of items) {
  const r = await call('POST', '/admin/listings', { category, items: [item] });
  const row = r.data.results?.[0] ?? { result: 'error', detail: r.data.error ?? `HTTP ${r.status}` };
  totals[row.result] = (totals[row.result] ?? 0) + 1;
  if (row.result === 'published' && !row.installable) totals.no_manifest++;
  const mark = { published: '✓', exists: '=', skip: '-', error: '✕' }[row.result] ?? '?';
  const note = row.result === 'published' ? (row.installable ? 'installable PWA' : row.inspected ? 'listed; not an installable PWA' : 'listed; site could not be read') : '';
  console.log(`${mark} ${item.url} → ${row.slug ? `${SERVER}/apps/${row.slug}` : row.result}  ${[note, row.detail].filter(Boolean).join(' · ')}`);
}
console.log(
  `\n${totals.published} published (${totals.no_manifest} without an installable manifest), ${totals.exists} already listed, ${totals.skip} skipped, ${totals.error} failed.`,
);
if (totals.error) process.exit(1);
