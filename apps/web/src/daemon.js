import { db } from '@pwamart/db';
import { dueReminders, markReminded } from './billing.js';
import { config } from './config.js';
import { sendRenewalReminder } from './mail.js';
import { expireFeatured, sendBatch, syncFeaturedAds } from './newsletter.js';

/**
 * The background loop inside the web process: one timer, several jobs, each with
 * its own cadence. Jobs never overlap themselves, and a job that throws is logged
 * and retried on its next turn rather than taking the server down.
 *
 * A Postgres advisory lock per job means a second container (during a deploy's
 * overlap) skips the turn instead of doing the same work twice.
 */
const jobs = [];

export function addJob(name, everyMs, run) {
  jobs.push({ name, everyMs, run, lastRun: 0, running: false, lockKey: hash(`pwamart:${name}`) });
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return h;
}

let lockConn = null;
/** The one connection the daemon's advisory locks are taken on (session locks are per connection). */
async function lockConnection() {
  lockConn ??= db().reserve();
  return lockConn;
}

async function tick() {
  const now = Date.now();
  for (const job of jobs) {
    if (job.running || now - job.lastRun < job.everyMs) continue;
    job.running = true;
    job.lastRun = now;
    (async () => {
      try {
        // Every job's lock lives on ONE dedicated connection; the job itself queries
        // through the pool. A reserved connection per job (the old way) let N jobs
        // take all N pool connections and then wait on the pool forever, which
        // hung every request on 2026-10-06.
        const lock = await lockConnection();
        const [{ ok }] = await lock`select pg_try_advisory_lock(${job.lockKey}) as ok`;
        if (!ok) return;
        try {
          await job.run();
        } finally {
          await lock`select pg_advisory_unlock(${job.lockKey})`;
        }
      } catch (err) {
        console.error(`[daemon] ${job.name}: ${err?.message ?? err}`);
      } finally {
        job.running = false;
      }
    })();
  }
}

let timer = null;
export function startDaemon({ intervalMs = 5_000 } = {}) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  console.log(`[daemon] started: ${jobs.map((j) => `${j.name}/${Math.round(j.everyMs / 1000)}s`).join(', ')}`);
}

/* ------------------------------------------------------------- reminders -- */

/** Renewal reminders 14 and 3 days before the paid time runs out, and once when it has. */
export async function runReminders() {
  let sent = 0;
  for (const r of await dueReminders()) {
    // Claim the notice first: a send that fails after this is not retried, which
    // beats a reminder that is sent twice.
    if (!(await markReminded(db(), { userId: r.user_id, periodEnd: r.period_end, kind: r.kind }))) continue;
    try {
      await sendRenewalReminder({
        email: r.email,
        plan: r.renew === 'same' ? r.plan : r.renew,
        periodEnd: r.period_end,
        kind: r.kind,
        url: `${config.siteUrl}/console/billing`,
      });
      sent++;
    } catch (err) {
      console.error(`[daemon] reminder to ${r.email}: ${err.message}`);
    }
  }
  return sent;
}

addJob('renewal-reminders', 60 * 60_000, runReminders);

// Pending DNS claims: due ones checked every tick; each claim schedules its own next
// check (15s for its first 10 minutes, then 30s), so the tick only has to be fast.
addJob('claim-checks', 5_000, async () => {
  const { runClaimChecks } = await import('./imports.js');
  await runClaimChecks();
});

// saasrow.com approved listings -> claimable PWA listings. 150 sites a pass every
// 20 minutes: the first sweep of the directory takes a few passes, after that a
// pass only inspects new listings and week-old misses, so it is nearly free.
addJob('saasrow-import', 20 * 60_000, async () => {
  if (process.env.SAASROW_IMPORT === 'off') return;
  const { runSaasrowImport } = await import('./imports.js');
  const r = await runSaasrowImport();
  console.log(`[daemon] saasrow-import ${JSON.stringify(r)}`);
});

/* ------------------------------------------------------------ listing ads -- */

/**
 * One CrawlProof campaign per published listing, pointing at its pwamart page.
 * A few per turn: CrawlProof reads the page and writes the creatives, which takes
 * a minute or so each. A failure is recorded and retried after a day, never in a
 * tight loop. Running it twice is safe: CrawlProof hands back the live campaign.
 */
export async function runListingAds({ batch = 4, createCampaign } = {}) {
  if (!config.crawlproof.apiToken && !createCampaign) return { created: 0, skipped: 'no CRAWLPROOF_API_TOKEN' };
  const make = createCampaign ?? (await import('./crawlproof.js')).createCampaign;
  const due = await db()`
    select id, slug, name from apps
    where status = 'published' and listing_ad_id is null
      and (listing_ad_error is null or listing_ad_at < now() - interval '1 day')
    order by featured desc, published_at limit ${batch}`;
  let created = 0;
  for (const a of due) {
    try {
      const c = await make({ url: `${config.siteUrl}/apps/${a.slug}`, name: `pwamart: ${a.name}`.slice(0, 80) });
      await db()`update apps set listing_ad_id = ${c.id}, listing_ad_ref = ${c.ref ?? null}, listing_ad_at = now(), listing_ad_error = null where id = ${a.id}`;
      created++;
    } catch (err) {
      await db()`update apps set listing_ad_at = now(), listing_ad_error = ${String(err.message).slice(0, 300)} where id = ${a.id}`;
    }
  }
  return { created, due: due.length };
}

addJob('listing-ads', 5 * 60_000, () => runListingAds());

/* ------------------------------------------------- releases + following -- */

// Re-read listings' manifests (each about daily) and record what visibly changed.
addJob('release-detect', 30 * 60_000, async () => {
  const { runReleaseDetect } = await import('./releases.js');
  const r = await runReleaseDetect();
  if (r.releases) console.log(`[daemon] release-detect ${JSON.stringify(r)}`);
});
// A newly published app becomes a "launched" release (its publisher's followers hear of it).
addJob('release-launches', 10 * 60_000, async () => {
  const { backfillLaunches } = await import('./releases.js');
  await backfillLaunches();
});
// Releases -> one delivery per follower and channel -> email / browser push.
addJob('release-notify', 60_000, async () => {
  const { queueDeliveries, sendDeliveries } = await import('./releases.js');
  await queueDeliveries();
  await sendDeliveries();
});

/* ------------------------------------------------------ feature tags -- */

/**
 * Listings never inspected for features (they predate the offline check) are
 * re-inspected a few per turn, one site at a time, so the backlog clears in an hour
 * or two without hammering anyone. A site that is down is marked checked anyway;
 * release-detect's daily re-read tags it when it is back.
 */
export async function runFeatureBackfill({ batch = 6, inspectFn, sql = db() } = {}) {
  const run = inspectFn ?? (await import('./inspect.js')).inspect;
  const { featureColumns } = await import('./inspect.js');
  const due = await sql`
    select id, url, origin from apps
    where status in ('published', 'unlisted') and features_checked_at is null
    order by published_at nulls last limit ${batch}`;
  let offline = 0;
  for (const a of due) {
    try {
      const r = await run(a.url);
      if (r.origin !== a.origin) throw new Error(`now lands on ${r.origin}`);
      const f = featureColumns(r);
      if (f.features.includes('offline')) offline++;
      await sql`update apps set features = ${f.features}::text[], offline_reason = ${f.offline_reason}, features_checked_at = now(),
                check_report = ${sql.json({ installable: r.installable, score: r.score, checks: r.checks })}
                where id = ${a.id}`;
    } catch (err) {
      await sql`update apps set features_checked_at = now(), offline_reason = ${`not checked: ${String(err?.message ?? err)}`.slice(0, 200)} where id = ${a.id}`;
    }
  }
  return { checked: due.length, offline };
}

addJob('feature-backfill', 2 * 60_000, async () => {
  const r = await runFeatureBackfill();
  if (r.checked) console.log(`[daemon] feature-backfill ${JSON.stringify(r)}`);
});

/* ------------------------------------------------- featured + newsletter -- */

// A paid feature comes off the home page when its week is up (staff picks never do).
addJob('featured-expiry', 10 * 60_000, () => expireFeatured());
// Its free CrawlProof campaign starts after the payment settles and pauses when the week ends.
addJob('featured-ads', 2 * 60_000, () => syncFeaturedAds());
// A queued issue goes out 50 subscribers a minute, each delivery claimed before it is sent.
addJob('newsletter-send', 60_000, () => sendBatch());
