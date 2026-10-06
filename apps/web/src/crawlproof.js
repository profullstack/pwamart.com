import { config } from './config.js';

/**
 * CrawlProof, server side: the ad network every featured app gets a free campaign
 * on, and the numbers the /advertise page sells with.
 *
 * Everything goes through the Profullstack account's API token (CRAWLPROOF_API_TOKEN
 * in pwamart--prod). Without it nothing here throws: campaigns wait in the queue and
 * the network numbers stay null, so the pages simply leave the figures out.
 *
 * Two traps in CrawlProof's numbers, both handled in summarizeNetwork():
 *   - delivery is split into paid and free halves; the network is all free tier, so
 *     the plain `impressions` column reads 0. The earnings totals are used instead.
 *   - invalid (refused) clicks are a separate bucket and are never counted as reach.
 */

const TIMEOUT = 15_000;

async function call(path, { method = 'GET', body, timeout = TIMEOUT, fetchImpl = fetch } = {}) {
  const token = config.crawlproof.apiToken;
  if (!token) throw new Error('CRAWLPROOF_API_TOKEN is not set');
  const res = await fetchImpl(`${config.crawlproof.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`crawlproof ${method} ${path.split('?')[0]}: ${res.status} ${data?.error ?? ''}`.trim());
  return data;
}

/* ------------------------------------------------------------- campaigns -- */

/**
 * One campaign for a featured app, pointing at its pwamart page so the Install
 * button is one click away. Creating writes the creatives, which can take a minute
 * or two; CrawlProof answers `existing: true` (and the same campaign) when a live one
 * for that URL is already running.
 */
export async function createCampaign({ url, name }, opts = {}) {
  const c = await call('/api/ads/v1/campaigns', { method: 'POST', body: { url, name, status: 'active' }, timeout: 150_000, ...opts });
  return { id: c.id, ref: c.ref_slug, existing: Boolean(c.existing), dashboardUrl: c.dashboard_url ?? null };
}

export async function setCampaignStatus(id, status, opts = {}) {
  await call(`/api/ads/v1/campaigns/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status }, ...opts });
}

/* --------------------------------------------------------------- network -- */

/**
 * The network in round numbers from three CrawlProof answers: 30 days of ad
 * delivery (earnings totals), the ad slots, and one 30-day human-traffic report per
 * site that carries a slot. Pure, so the page math is testable without the network.
 */
export function summarizeNetwork({ earnings, slots, traffic = [] }) {
  const t = earnings?.totals ?? {};
  const impressions = num(t.pubPaidImpressions) + num(t.pubFreeImpressions) || num(t.pubImpressions);
  const clicks = num(t.pubBilledClicks) + num(t.pubFreeClicks) || num(t.pubClicks);
  const active = (slots ?? []).filter((s) => s.status === 'active');
  const sites = [...new Set(active.map((s) => s.site).filter(Boolean))];
  const reports = traffic.filter((r) => r && Number.isFinite(r.visitors));
  const properties = reports
    .map((r) => ({ site: r.site, visitors: r.visitors, pageviews: num(r.pageviews) }))
    .sort((a, b) => b.visitors - a.visitors);
  return {
    days: earnings?.rangeDays ?? 30,
    impressions,
    clicks,
    ctr: impressions ? clicks / impressions : 0,
    slots: active.length,
    sites: sites.length,
    visitors: reports.length ? properties.reduce((s, p) => s + p.visitors, 0) : null,
    pageviews: reports.length ? properties.reduce((s, p) => s + p.pageviews, 0) : null,
    properties,
    measuredSites: reports.length,
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function trafficFor(site, opts) {
  try {
    const r = await call(`/api/tracker/v1/stats?site=${encodeURIComponent(site)}&range=1m&who=humans`, opts);
    return { site, visitors: r?.totals?.visitors ?? null, pageviews: r?.totals?.pageviews ?? null };
  } catch {
    return null;
  }
}

/** Fetch everything summarizeNetwork needs: 2 calls, then one per site, 4 at a time. */
export async function fetchNetwork(opts = {}) {
  const [earnings, slotList] = await Promise.all([call('/api/ads/v1/earnings?days=30', opts), call('/api/ads/v1/slots', opts)]);
  const slots = slotList?.slots ?? [];
  const sites = [...new Set(slots.filter((s) => s.status === 'active').map((s) => s.site).filter(Boolean))];
  const traffic = [];
  for (let i = 0; i < sites.length; i += 4) traffic.push(...(await Promise.all(sites.slice(i, i + 4).map((s) => trafficFor(s, opts)))));
  return summarizeNetwork({ earnings, slots, traffic });
}

// Stale-while-revalidate, in memory: a page never waits on CrawlProof. The first
// request after boot gets null (figures left out) and starts the refresh.
const FRESH_MS = 6 * 60 * 60_000;
let cache = { at: 0, value: null, pending: null };

export function networkStats() {
  if (!config.crawlproof.apiToken) return null;
  if (Date.now() - cache.at > FRESH_MS && !cache.pending) refreshNetwork();
  return cache.value;
}

export function refreshNetwork() {
  cache.pending = fetchNetwork()
    .then((value) => {
      cache = { at: Date.now(), value: { ...value, updatedAt: new Date().toISOString() }, pending: null };
    })
    .catch((err) => {
      console.error(`[crawlproof] network stats: ${err.message}`);
      // Try again in 10 minutes rather than on every request.
      cache = { ...cache, at: Date.now() - FRESH_MS + 10 * 60_000, pending: null };
    });
  return cache.pending;
}
