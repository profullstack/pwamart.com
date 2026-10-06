#!/usr/bin/env bun
/**
 * Seed the store with Profullstack's own PWAs: every domain on the account that
 * passed the inspector on 2026-10-06, de-duplicated by the origin it lands on.
 *
 *   PWAMART_API_KEY=pm_live_... [PWAMART_URL=https://pwamart.com] bun bin/seed-fleet.mjs
 *
 * The key must belong to a staff account (ADMIN_EMAILS): staff verification stands
 * in for the .well-known file on sites we own. Re-running is safe: an app that
 * exists is skipped, a draft is verified and published.
 */
const SERVER = (process.env.PWAMART_URL || 'https://pwamart.com').replace(/\/$/, '');
const KEY = process.env.PWAMART_API_KEY;
if (!KEY) throw new Error('PWAMART_API_KEY is required (a staff account key)');

const FLEET = {
  'tronbrowser.dev': ['utilities', true],
  'hqtui.com': ['developer-tools', true],
  'qrypt.chat': ['communication', true],
  'typeheard.com': ['ai', true],
  'bufferoverride.com': ['security'],
  'brisk.news': ['news'],
  'c0ncerts.com': ['media'],
  'chovy.com': ['ai'],
  'd3vices.com': ['utilities'],
  'nixamp.com': ['media'],
  'p0dcasters.com': ['media'],
  'threatcrush.com': ['security'],
  'tleehealth.com': ['health'],
  'w3bs.org': ['developer-tools'],
  'b1dz.com': ['finance'],
  'backtoschool.help': ['education'],
  'advis0r.com': ['finance'],
  'bl0ggers.com': ['ai'],
  'c0upons.com': ['shopping'],
  'logicsrc.com': ['developer-tools'],
  'crawlproof.com': ['developer-tools'],
  'd0rz.com': ['lifestyle'],
  'diskpush.com': ['utilities'],
  'demo.movie': ['ai'],
  'genrewatch.com': ['media'],
  'icemap.app': ['social'],
  'infernetprotocol.com': ['ai'],
  'marksyncr.com': ['productivity'],
  'media2markdown.com': ['productivity'],
  'mediaanalyzer.pro': ['ai'],
  'meshhook.com': ['developer-tools'],
  'mynaposter.com': ['business'],
  'nichedb.dev': ['business'],
  'opensocial.chat': ['social'],
  'outreachgraph.com': ['business'],
  'pairux.com': ['communication'],
  'phonenumbers.bot': ['communication'],
  'postammo.com': ['business'],
  'r4ck.dev': ['developer-tools'],
  'rssamplifier.com': ['news'],
  'smshub.dev': ['communication'],
  'tipoffwatch.com': ['news'],
  'tsbb.dev': ['social'],
  'ugig.net': ['business'],
  'weedforcrypto.com': ['shopping'],
  'watchnews.now': ['news'],
  'agenticjobs.work': ['business'],
  'c0mpute.com': ['ai'],
  'coinpayportal.com': ['finance'],
  'pwamart.com': ['utilities', true],
};

async function call(method, path, body) {
  const res = await fetch(`${SERVER}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const me = await call('GET', '/me');
if (me.status !== 200) throw new Error(`/me: ${me.data.error}`);
if (!me.data.user.admin) throw new Error(`${me.data.user.email} is not staff`);

if (!me.data.publishers.some((p) => p.slug === 'profullstack')) {
  const p = await call('POST', '/publishers', { name: 'Profullstack', slug: 'profullstack', website: 'https://profullstack.com', bio: 'We build the open-web tools behind pwamart, TronBrowser and hqtui. Every app here is ours.' });
  if (p.status !== 201) throw new Error(`publisher: ${p.data.error}`);
}
await call('POST', '/admin/publishers/profullstack', { verified: true });

const mine = new Map((await call('GET', '/me/apps')).data.apps.map((a) => [new URL(a.origin).host, a]));
for (const [host, [category, featured]] of Object.entries(FLEET)) {
  let app = mine.get(host);
  if (!app) {
    const r = await call('POST', '/apps', { url: `https://${host}/`, publisher: 'profullstack', category });
    if (r.status !== 201) {
      console.log(`✕ ${host}: ${r.data.error}`);
      continue;
    }
    app = r.data.app;
  }
  if (!app.verified) await call('POST', `/admin/apps/${app.slug}`, { verified: true });
  if (featured) await call('POST', `/admin/apps/${app.slug}`, { featured: true });
  const p = app.status === 'published' ? { data: { status: 'published' } } : await call('POST', `/apps/${app.slug}/publish`);
  console.log(`${p.data.status === 'published' ? '✓' : '✕'} ${host} → ${app.slug} ${p.data.error ?? ''}`);
}
