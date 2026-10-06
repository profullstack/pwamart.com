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

async function tick() {
  const now = Date.now();
  for (const job of jobs) {
    if (job.running || now - job.lastRun < job.everyMs) continue;
    job.running = true;
    job.lastRun = now;
    (async () => {
      const sql = db();
      const reserved = await sql.reserve();
      try {
        const [{ ok }] = await reserved`select pg_try_advisory_lock(${job.lockKey}) as ok`;
        if (!ok) return;
        try {
          await job.run();
        } finally {
          await reserved`select pg_advisory_unlock(${job.lockKey})`;
        }
      } catch (err) {
        console.error(`[daemon] ${job.name}: ${err?.message ?? err}`);
      } finally {
        reserved.release();
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

/* ------------------------------------------------- featured + newsletter -- */

// A paid feature comes off the home page when its week is up (staff picks never do).
addJob('featured-expiry', 10 * 60_000, () => expireFeatured());
// Its free CrawlProof campaign starts after the payment settles and pauses when the week ends.
addJob('featured-ads', 2 * 60_000, () => syncFeaturedAds());
// A queued issue goes out 50 subscribers a minute, each delivery claimed before it is sent.
addJob('newsletter-send', 60_000, () => sendBatch());
