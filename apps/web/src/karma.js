import { createHash } from 'node:crypto';
import { db } from '@pwamart/db';
import { createLeaderboard, projectionStore, sqlStore } from '@profullstack/leaderboard';
import { config } from './config.js';

/**
 * Karma: the same points for the same actions as built.indie, so the two programs
 * read as one network. One append-only ledger (karma_events); a member's karma is
 * the sum of their rows; a reversal is a new negative row; the unique key
 * (user, action, ref, bucket) means a retry or a double click never pays twice.
 *
 * Signed-in members only; anonymous actions still work and earn nothing. Staff
 * accounts earn nothing (bulk seeding must not top the board), and nobody earns on
 * a listing their own org publishes. Installs never earn (too easy to farm).
 */

export const ACTIONS = {
  publish: { points: 10, label: 'Publish an app', rule: 'the first time a listing goes live' },
  vote: { points: 1, daily: 20, label: 'Upvote an app', rule: 'not your own; up to 20 paid votes a day' },
  review: { points: 5, label: 'Review an app', rule: 'a rating and at least 30 characters; once per app; not your own' },
  comment: { points: 2, daily: 10, label: 'Comment on an app', rule: 'at least 10 characters; up to 10 paid a day; deleting it takes the points back' },
  share: { points: 1, daily: 5, label: 'Share an app', rule: 'the share buttons on an app page; once per app per network a day; up to 5 a day' },
  received_vote: { points: 1, label: 'Your app is upvoted', rule: 'to the app owner, per vote from someone else' },
  received_review: { points: 2, label: 'Your app is reviewed', rule: 'to the app owner, per review from someone else' },
  verify: { points: 5, label: 'Prove you own an app', rule: 'DNS, meta tag, manifest or /.well-known; once per app' },
  badge: { points: 5, label: 'Show the pwamart badge', rule: 'the live badge on your site links back, verified; once per app' },
  // Same table as built.indie; not paid on pwamart until the store tracks invited makers.
  invite: { points: 25, label: 'Invite a maker', rule: 'an invited new member launches their first app', live: false },
};

/** The networks a tracked share button can name. Only these pay. */
export const SHARE_NETWORKS = ['x', 'bluesky', 'linkedin', 'reddit', 'hn', 'mastodon', 'copy'];

export const MIN_REVIEW_CHARS = 30;
export const MIN_COMMENT_CHARS = 10;

export const perCredit = () => Math.max(1, Number(process.env.KARMA_PER_CREDIT) || 500);

/** The "how to earn" table, for pages, the API, the CLI and MCP. */
export const howToEarn = () =>
  Object.entries(ACTIONS)
    .filter(([, a]) => a.live !== false)
    .map(([action, a]) => ({ action, points: a.points, label: a.label, rule: a.rule }));

/** UTC day, the bucket for once-a-day actions and the window for daily caps. */
export const dayOf = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** The leaderboard's public player id: stable, and not the account id. */
export const playerId = (userId) => createHash('sha256').update(`pwamart-karma:${userId}`).digest('hex').slice(0, 12);

/**
 * Where the next free Featured week lands. `granted` is the highest milestone already
 * granted, so a dip in karma never re-offers a credit already given.
 */
export function nextCredit(total, granted = 0, per = perCredit()) {
  const reached = Math.max(granted, Math.floor(Math.max(total, 0) / per));
  const at = (reached + 1) * per;
  return { at, remaining: at - total, per, progress: Math.max(0, Math.min(1, 1 - (at - total) / per)) };
}

/* ------------------------------------------------------------- the ledger -- */

/** Is this member in the org that publishes the app? (Self-dealing earns nothing.) */
export async function ownsApp(userId, publisherId, sql = db()) {
  if (!userId || !publisherId) return false;
  const [r] = await sql`select 1 as one from publishers p join org_members m on m.org_id = p.org_id
                        where p.id = ${publisherId} and m.user_id = ${userId} limit 1`;
  return Boolean(r);
}

/** The publisher's owner account (whoever created its org), who receives votes and reviews. */
export async function ownerOf(publisherId, sql = db()) {
  const [r] = await sql`select o.created_by from publishers p join organizations o on o.id = p.org_id where p.id = ${publisherId}`;
  return r?.created_by ?? null;
}

/**
 * Pay one action. Returns the row written, or null with a reason when it pays nothing
 * (anonymous, staff, duplicate, past the daily cap). Its own transaction, serialized
 * per member by an advisory lock so two parallel requests cannot both slip under a cap.
 */
export async function award({ userId, action, ref, appId = null, bucket = '' }) {
  const a = ACTIONS[action];
  if (!a) throw new Error(`unknown karma action ${action}`);
  if (!userId) return { paid: false, reason: 'anonymous' };
  const sql = db();
  const out = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`karma:${userId}`}))`;
    const [u] = await tx`select is_admin from users where id = ${userId}`;
    if (!u) return { paid: false, reason: 'no such member' };
    if (u.is_admin) return { paid: false, reason: 'staff' };
    if (a.daily) {
      const [{ n }] = await tx`select count(*)::int as n from karma_events
                               where user_id = ${userId} and action = ${action} and points > 0
                                 and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
      if (n >= a.daily) return { paid: false, reason: `daily cap of ${a.daily}` };
    }
    const [row] = await tx`insert into karma_events (user_id, action, ref, bucket, points, app_id)
                           values (${userId}, ${action}, ${String(ref)}, ${bucket}, ${a.points}, ${appId})
                           on conflict (user_id, action, ref, bucket) do nothing returning id, points`;
    if (!row) return { paid: false, reason: 'already paid' };
    const credits = await grantCredits(tx, userId);
    return { paid: true, points: row.points, credits };
  });
  if (out.paid) touched(userId);
  return out;
}

/** Take back one paid row (a deleted comment). Once only; nothing if it never paid. */
export async function reverse({ userId, action, ref }) {
  if (!userId) return { reversed: false };
  const sql = db();
  const out = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`karma:${userId}`}))`;
    const [paid] = await tx`select points, app_id from karma_events
                            where user_id = ${userId} and action = ${action} and ref = ${String(ref)} and bucket = '' and points > 0`;
    if (!paid) return { reversed: false };
    const [row] = await tx`insert into karma_events (user_id, action, ref, bucket, points, app_id)
                           values (${userId}, ${action}, ${String(ref)}, 'reversed', ${-paid.points}, ${paid.app_id})
                           on conflict (user_id, action, ref, bucket) do nothing returning points`;
    return { reversed: Boolean(row), points: row?.points ?? 0 };
  });
  if (out.reversed) touched(userId);
  return out;
}

/** Grant every crossed milestone not granted yet. Inside award's transaction. */
async function grantCredits(tx, userId) {
  const [{ total }] = await tx`select coalesce(sum(points), 0)::int as total from karma_events where user_id = ${userId}`;
  const reached = Math.floor(total / perCredit());
  if (reached < 1) return 0;
  const rows = await tx`insert into karma_credits (user_id, milestone)
                        select ${userId}, g from generate_series(1, ${reached}::int) g
                        on conflict (user_id, milestone) do nothing returning milestone`;
  return rows.length;
}

export async function karmaOf(userId) {
  const [r] = await db()`select coalesce(sum(points), 0)::int as total from karma_events where user_id = ${userId}`;
  return r.total;
}

/** Everything the member page shows: total, this week, credits, the next one, history. */
export async function summary(userId, { limit = 30 } = {}) {
  const sql = db();
  const [[t], credits, events] = await Promise.all([
    sql`select coalesce(sum(points), 0)::int as total,
               coalesce(sum(points) filter (where created_at >= now() - interval '7 days'), 0)::int as week
        from karma_events where user_id = ${userId}`,
    sql`select c.id, c.milestone, c.granted_at, c.spent_at, a.slug as app_slug, a.name as app_name
        from karma_credits c left join apps a on a.id = c.app_id where c.user_id = ${userId} order by c.milestone`,
    sql`select k.action, k.points, k.bucket, k.created_at, a.slug as app_slug, a.name as app_name
        from karma_events k left join apps a on a.id = k.app_id
        where k.user_id = ${userId} order by k.created_at desc, k.id desc limit ${Math.min(Math.max(Number(limit) || 30, 1), 200)}`,
  ]);
  const granted = credits.reduce((m, c) => Math.max(m, c.milestone), 0);
  return {
    total: t.total,
    week: t.week,
    player: playerId(userId),
    credits: {
      available: credits.filter((c) => !c.spent_at).length,
      granted: credits.length,
      spent: credits.filter((c) => c.spent_at).length,
      list: credits.map((c) => ({ id: c.id, milestone: c.milestone * perCredit(), granted_at: c.granted_at, spent_at: c.spent_at, app: c.app_slug ? { slug: c.app_slug, name: c.app_name } : null })),
    },
    next_credit: nextCredit(t.total, granted),
    events: events.map((e) => ({
      action: e.action,
      label: ACTIONS[e.action]?.label ?? e.action,
      points: e.points,
      reversal: e.bucket === 'reversed',
      at: e.created_at,
      app: e.app_slug ? { slug: e.app_slug, name: e.app_name } : null,
    })),
    how_to_earn: howToEarn(),
  };
}

/**
 * Spend one credit on one of the member's live apps: the same grant a $19 CoinPay
 * payment runs (a featured_slots row keyed on a payment), through a zero-amount
 * `payments` row from provider 'karma', and the slot marked paid_with 'credit'.
 */
export async function spendCredit({ user, app }) {
  const { grantFeatured } = await import('./newsletter.js');
  return db().begin(async (tx) => {
    const [credit] = await tx`select id from karma_credits where user_id = ${user.id} and spent_at is null
                              order by milestone limit 1 for update skip locked`;
    if (!credit) return { error: 'no free Featured week credit yet', status: 402 };
    const [payment] = await tx`
      insert into payments (user_id, provider, provider_ref, amount_cents, status, raw)
      values (${user.id}, 'karma', ${`credit:${credit.id}`}, 0, 'paid',
              ${tx.json({ metadata: { product: 'featured', app_id: app.id, app_slug: app.slug, user_id: user.id, paid_with: 'karma' } })})
      returning id, amount_cents`;
    const r = await grantFeatured(tx, { meta: { user_id: user.id, app_id: app.id }, payment, credit: true });
    if (!r?.featured) throw new Error('the app could not be featured');
    await tx`update featured_slots set paid_with = 'credit' where payment_id = ${payment.id}`;
    await tx`update karma_credits set spent_at = now(), app_id = ${app.id}, payment_id = ${payment.id} where id = ${credit.id}`;
    const [{ n }] = await tx`select count(*)::int as n from karma_credits where user_id = ${user.id} and spent_at is null`;
    return { featured: true, ends_at: r.ends_at, credits_left: n };
  });
}


/* ------------------------------------------------------------ leaderboard -- */

const total = (p) => Number(p.totals?.karma ?? 0);
const bestRank = (p, period) => p.ranks?.karma?.[period] ?? Infinity;

let board = null;

/**
 * The karma board on @profullstack/leaderboard: a projection of karma_events (no
 * second copy of the facts), badges in lb_badges. The package serves
 * /leaderboard.json, /leaderboard/karma.json|.xml, /leaderboard/u/<id> and the
 * widget; the /leaderboard page itself is ours, in the site layout.
 */
export function leaderboard() {
  if (board) return board;
  const badges = sqlStore({ dialect: 'postgres', execute: async ({ sql, args }) => ({ rows: await db().unsafe(sql, args ?? []) }) });
  board = createLeaderboard({
    siteName: 'pwamart',
    siteUrl: config.siteUrl,
    periods: ['week', 'month', 'all'],
    defaultPeriod: 'week',
    sides: { use: 'Members' },
    boards: { karma: { label: 'Top karma', metric: 'karma', format: 'integer', unit: 'Karma', side: 'use', actor: 'Member', min: 1 } },
    badges: [
      { id: 'first-karma', emoji: '✨', label: 'First karma', describe: 'Earned 10 karma', when: (p) => total(p) >= 10 },
      { id: 'karma-100', emoji: '💯', label: '100 karma', describe: 'Earned 100 karma', when: (p) => total(p) >= 100 },
      { id: 'karma-1000', emoji: '🌟', label: '1,000 karma', describe: 'Earned 1,000 karma', when: (p) => total(p) >= 1000 },
      { id: 'top-ten-week', emoji: '🏅', label: 'Top ten this week', describe: 'In a weekly top ten', when: (p) => bestRank(p, 'week') <= 10 },
      { id: 'number-one', emoji: '👑', label: 'Number one', describe: 'Top of the board for a week, a month or all time', when: (p) => [bestRank(p, 'week'), bestRank(p, 'month'), bestRank(p, 'all')].includes(1) },
    ],
    store: projectionStore({
      events: async ({ since }) => {
        const rows = await db()`
          select k.user_id, coalesce(nullif(u.name, ''), split_part(u.email, '@', 1)) as name,
                 date_trunc('hour', k.created_at) as at, sum(k.points)::int as delta
          from karma_events k join users u on u.id = k.user_id
          where k.created_at >= ${new Date(since || 0)} and not u.is_admin
          group by 1, 2, 3`;
        return rows.map((r) => ({ player: playerId(r.user_id), name: r.name, metric: 'karma', delta: r.delta, at: +new Date(r.at) }));
      },
      badges,
    }),
  });
  return board;
}

/**
 * After any karma write: drop the cached board and re-check badges. A projection
 * board never calls record(), so without award() no badge would ever appear.
 */
export function touched(userId) {
  const lb = leaderboard();
  lb.invalidate();
  return lb.award(playerId(userId)).catch((err) => console.error(`[karma] badges: ${err?.message ?? err}`));
}

/** Top karma this week, falling back to all time so the widget is never empty. */
export async function topKarma({ limit = 5 } = {}) {
  const lb = leaderboard();
  const week = await lb.top({ board: 'karma', period: 'week', limit });
  if (week.rows.length) return { ...week, fallback: false };
  return { ...(await lb.top({ board: 'karma', period: 'all', limit })), fallback: true };
}
