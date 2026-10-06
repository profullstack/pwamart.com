import { randomBytes } from 'node:crypto';
import { db } from '@pwamart/db';
import { config } from './config.js';
import { send } from './mail.js';

/**
 * Get featured for $19, and the newsletter it buys a slot in.
 *
 *   featured    a CoinPay payment (metadata product: 'featured') puts one app on the
 *               home page's Featured row and at the top of the default sort for
 *               FEATURED_DAYS, and owes it a slot in the next newsletter issue.
 *   newsletter  double opt-in subscribers; staff draft an issue (owed slots first,
 *               then the week's new apps), queue it, and the daemon sends it in batches.
 */

export const FEATURED = { priceCents: 1900, days: 7 };
const BATCH = 50;

/* -------------------------------------------------------------- featured -- */

/**
 * The webhook's grant for a featured purchase, inside settleWebhook's transaction.
 * Returns null to decline (wrong amount, app gone), `{already: true}` on a replay.
 * A second purchase for an app that is still featured extends it from its end.
 */
export async function grantFeatured(tx, { meta, payment }) {
  if (!meta.user_id || !meta.app_id || !payment) return null;
  if (payment.amount_cents < FEATURED.priceCents) return null;
  const [app] = await tx`select id, featured, featured_until from apps where id = ${meta.app_id} and status = 'published'`;
  if (!app) return null;
  // A staff pick (featured, no end date) stays a staff pick; the payment still buys
  // the newsletter slot.
  const staffPick = app.featured && !app.featured_until;
  const from = app.featured_until && new Date(app.featured_until) > new Date() ? new Date(app.featured_until) : new Date();
  const ends = new Date(from.getTime() + FEATURED.days * 86_400_000);
  const [fresh] = await tx`insert into featured_slots (payment_id, app_id, user_id, starts_at, ends_at)
                           values (${payment.id}, ${app.id}, ${meta.user_id}, ${from}, ${ends})
                           on conflict (payment_id) do nothing returning payment_id`;
  if (!fresh) return { already: true };
  if (!staffPick) await tx`update apps set featured = true, featured_until = ${ends} where id = ${app.id}`;
  return { featured: true, app_id: app.id, ends_at: ends.toISOString() };
}

/** Take paid features off the home page when their week is up. Staff picks never expire. */
export async function expireFeatured(sql = db()) {
  const rows = await sql`update apps set featured = false, featured_until = null
                         where featured_until is not null and featured_until <= now() returning slug`;
  return rows.length;
}

/** What one app's featured state looks like to its owner. */
export async function featuredState(appId) {
  const [app] = await db()`select featured, featured_until from apps where id = ${appId}`;
  const slots = await db()`select s.starts_at, s.ends_at, s.issue_id, i.sent_at as issue_sent_at
                           from featured_slots s left join newsletter_issues i on i.id = s.issue_id
                           where s.app_id = ${appId} order by s.created_at desc limit 10`;
  return {
    featured: Boolean(app?.featured),
    featured_until: app?.featured_until ?? null,
    newsletter_owed: slots.some((s) => !s.issue_id),
    slots,
    price_cents: FEATURED.priceCents,
    days: FEATURED.days,
  };
}

/* ----------------------------------------------------------- subscribers -- */

const token = () => randomBytes(24).toString('base64url');
const confirmUrl = (t) => `${config.siteUrl}/newsletter/confirm?t=${encodeURIComponent(t)}`;
const unsubscribeUrl = (t) => `${config.siteUrl}/newsletter/unsubscribe?t=${encodeURIComponent(t)}`;

/**
 * Subscribe (or re-subscribe) and send the confirmation link. Always answers the
 * same way whether or not the address was already on the list, so the form cannot
 * be used to find out who reads pwamart.
 */
export async function subscribe(email, { source = 'site' } = {}) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254) return { ok: false, error: 'that does not look like an email address' };
  const [row] = await db()`
    insert into newsletter_subscribers (email, token, source) values (${address}, ${token()}, ${String(source).slice(0, 40)})
    on conflict ((lower(email))) do update set unsubscribed_at = null,
      confirmed_at = case when newsletter_subscribers.unsubscribed_at is null then newsletter_subscribers.confirmed_at else null end
    returning token, confirmed_at`;
  if (!row.confirmed_at) {
    await send({
      to: address,
      subject: 'Confirm your pwamart newsletter subscription',
      text: `Tap to get the pwamart newsletter: new and featured web apps, about once a week.\n\n${confirmUrl(row.token)}\n\nIf you did not ask for it, ignore this email and nothing happens.`,
    }).catch((err) => console.error(`[newsletter] confirm mail to ${address}: ${err.message}`));
  }
  return { ok: true };
}

export async function confirm(t) {
  const [row] = await db()`update newsletter_subscribers set confirmed_at = coalesce(confirmed_at, now()), unsubscribed_at = null
                           where token = ${String(t ?? '')} returning email`;
  return row ?? null;
}

export async function unsubscribe(t) {
  const [row] = await db()`update newsletter_subscribers set unsubscribed_at = coalesce(unsubscribed_at, now())
                           where token = ${String(t ?? '')} returning email`;
  return row ?? null;
}

export async function subscriberCounts() {
  const [c] = await db()`select count(*) filter (where confirmed_at is not null and unsubscribed_at is null)::int as active,
                                count(*) filter (where confirmed_at is null and unsubscribed_at is null)::int as pending,
                                count(*) filter (where unsubscribed_at is not null)::int as unsubscribed
                         from newsletter_subscribers`;
  return c;
}

/* ---------------------------------------------------------------- issues -- */

const appLine = (a) => `${a.name}\n${a.summary ? `${a.summary}\n` : ''}${config.siteUrl}/apps/${a.slug}\n`;

/**
 * Draft the next issue: every app owed a paid slot first (they are claimed by
 * this issue, so the next draft does not repeat them), then apps published since
 * the last sent issue. Staff edit the text before queueing.
 */
export async function draftIssue({ userId, subject, intro } = {}) {
  return db().begin(async (tx) => {
    const [last] = await tx`select sent_at from newsletter_issues where status = 'sent' order by sent_at desc limit 1`;
    const since = last?.sent_at ?? new Date(Date.now() - 7 * 86_400_000);
    const owed = await tx`select distinct on (a.id) s.payment_id, a.id, a.slug, a.name, a.summary
                          from featured_slots s join apps a on a.id = s.app_id
                          where s.issue_id is null and a.status = 'published' order by a.id, s.created_at`;
    const fresh = await tx`select slug, name, summary from apps
                           where status = 'published' and published_at > ${since}
                             and not (id = any(${owed.map((a) => a.id)}::uuid[]))
                           order by installs desc, published_at desc limit 12`;
    const lines = [
      intro ? `${String(intro).trim()}\n` : 'New and featured web apps on pwamart this week. Every one installs from the browser: no app store, no review queue.\n',
    ];
    if (owed.length) lines.push('FEATURED\n', ...owed.map(appLine));
    if (fresh.length) lines.push('NEW THIS WEEK\n', ...fresh.map(appLine));
    lines.push(`Get your app featured here and on the pwamart home page for $${FEATURED.priceCents / 100}: ${config.siteUrl}/featured\n`);
    const [issue] = await tx`insert into newsletter_issues (subject, body, created_by)
                             values (${String(subject ?? `pwamart: ${owed[0]?.name ?? 'new web apps'} and more`).slice(0, 200)}, ${lines.join('\n')}, ${userId ?? null})
                             returning *`;
    if (owed.length) await tx`update featured_slots set issue_id = ${issue.id} where payment_id = any(${owed.map((a) => a.payment_id)}::uuid[])`;
    // Older slots for the same apps are covered by this issue too.
    if (owed.length) await tx`update featured_slots set issue_id = ${issue.id} where issue_id is null and app_id = any(${owed.map((a) => a.id)}::uuid[])`;
    return { ...issue, featured: owed.map((a) => a.slug), fresh: fresh.map((a) => a.slug) };
  });
}

export async function updateIssue(id, { subject, body }) {
  const [issue] = await db()`update newsletter_issues set
      subject = coalesce(${subject ? String(subject).slice(0, 200) : null}, subject),
      body = coalesce(${body ? String(body).slice(0, 50_000) : null}, body)
    where id = ${id} and status = 'draft' returning *`;
  return issue ?? null;
}

/** Hand an issue to the daemon. Only a draft can be queued, so an issue goes out once. */
export async function queueIssue(id) {
  const [issue] = await db()`update newsletter_issues set status = 'sending', queued_at = now()
                             where id = ${id} and status = 'draft' returning *`;
  return issue ?? null;
}

export async function listIssues() {
  return db()`select i.id, i.subject, i.status, i.created_at, i.queued_at, i.sent_at,
                     (select count(*) from newsletter_deliveries d where d.issue_id = i.id)::int as delivered
              from newsletter_issues i order by i.created_at desc limit 50`;
}

export async function getIssue(id) {
  const [issue] = await db()`select * from newsletter_issues where id = ${id}`;
  return issue ?? null;
}

/** One batch of the issue being sent. Called by the daemon; returns how many went out. */
export async function sendBatch({ mail = send } = {}) {
  const [issue] = await db()`select * from newsletter_issues where status = 'sending' order by queued_at limit 1`;
  if (!issue) return 0;
  const due = await db()`select s.id, s.email, s.token from newsletter_subscribers s
                         where s.confirmed_at is not null and s.unsubscribed_at is null
                           and not exists (select 1 from newsletter_deliveries d where d.issue_id = ${issue.id} and d.subscriber_id = s.id)
                         order by s.created_at limit ${BATCH}`;
  if (!due.length) {
    await db()`update newsletter_issues set status = 'sent', sent_at = now() where id = ${issue.id}`;
    return 0;
  }
  let sent = 0;
  for (const s of due) {
    const [claimed] = await db()`insert into newsletter_deliveries (issue_id, subscriber_id) values (${issue.id}, ${s.id})
                                 on conflict do nothing returning issue_id`;
    if (!claimed) continue;
    try {
      await mail({ to: s.email, subject: issue.subject, text: `${issue.body}\n--\nUnsubscribe: ${unsubscribeUrl(s.token)}\n` });
      sent++;
    } catch (err) {
      await db()`update newsletter_deliveries set error = ${String(err.message).slice(0, 300)} where issue_id = ${issue.id} and subscriber_id = ${s.id}`;
    }
  }
  return sent;
}

