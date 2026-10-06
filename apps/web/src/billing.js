import { db } from '@pwamart/db';
import { PLANS } from './config.js';

/**
 * Plans as paid periods (migration 0002). Payment is prepaid crypto: nothing is
 * charged automatically, so the account is on whatever plan a paid period covers
 * right now, and "renewing" is paying for the next one. What happens at the end
 * is `account_billing.renew`: the same plan, a different one, or 'none'
 * (cancelled: the plan runs out and the account is free).
 *
 * Changes:
 *   upgrade   Pro -> Unlimited: immediate, a new year from today, priced at
 *             Unlimited minus the unused Pro time (all of it, queued years too).
 *   renew     same plan: a year queued after the last paid day.
 *   downgrade Unlimited -> Pro: set `renew` to 'pro'; optionally prepay it, which
 *             queues the Pro year to start when Unlimited ends.
 *   cancel    `renew` = 'none'. Resume puts it back.
 */

export const RANK = { free: 0, pro: 1, unlimited: 2 };
const YEAR_MS = 365 * 86400_000;

const periodsFor = (sql, userId) =>
  sql`select id, plan, starts_at, ends_at from plan_periods where user_id = ${userId} and ends_at > now() order by starts_at`;

/** The plan in force right now. Staff are unlimited and never billed. */
export async function currentPlan(userId, sql = db()) {
  const [u] = await sql`select is_admin from users where id = ${userId}`;
  if (u?.is_admin) return { key: 'unlimited', ...PLANS.unlimited, staff: true, period: null, paid_through: null };
  const [p] = await sql`
    select plan, starts_at, ends_at from plan_periods
    where user_id = ${userId} and starts_at <= now() and ends_at > now()
    order by case plan when 'unlimited' then 2 else 1 end desc limit 1`;
  const key = p?.plan ?? 'free';
  return { key, ...PLANS[key], staff: false, period: p ?? null, paid_through: p?.ends_at ?? null };
}

/** Everything the billing page shows. */
export async function billingState(userId, sql = db()) {
  const [plan, periods, [settings]] = await Promise.all([
    currentPlan(userId, sql),
    periodsFor(sql, userId),
    sql`select renew, canceled_at from account_billing where user_id = ${userId}`,
  ]);
  const coverageEnd = periods.length ? periods[periods.length - 1].ends_at : null;
  const renew = settings?.renew ?? 'same';
  const renewPlan = renew === 'same' ? (plan.key === 'free' ? null : plan.key) : renew === 'none' ? null : renew;
  const status = plan.staff ? 'staff' : plan.key === 'free' ? (periods.length ? 'scheduled' : 'free') : renew === 'none' ? 'ending' : 'active';
  const quotes = {};
  for (const target of ['pro', 'unlimited']) quotes[target] = await quote(userId, target, sql);
  return {
    plan,
    status,
    periods: periods.map((p) => ({ plan: p.plan, starts_at: p.starts_at, ends_at: p.ends_at, current: new Date(p.starts_at) <= new Date() })),
    coverage_end: coverageEnd,
    renew,
    renew_plan: renewPlan,
    canceled_at: settings?.canceled_at ?? null,
    quotes,
  };
}

/**
 * What buying `target` costs and does, right now. The webhook re-derives the
 * timing when the money lands (applyPurchase), so a quote that sat in a tab for
 * a day still lands correctly; only the amount is fixed at checkout.
 */
export async function quote(userId, target, sql = db()) {
  if (!PLANS[target] || target === 'free') throw new Error('bad plan');
  const now = Date.now();
  const plan = await currentPlan(userId, sql);
  if (plan.staff) return { kind: 'staff', amount_cents: 0, credit_cents: 0, starts_at: null, ends_at: null };
  const periods = await periodsFor(sql, userId);
  const last = periods.length ? new Date(periods[periods.length - 1].ends_at).getTime() : now;

  if (RANK[target] > RANK[plan.key] && plan.key === 'pro') {
    // Credit every unused Pro day, current and queued, at the Pro price.
    const proMs = periods
      .filter((p) => p.plan === 'pro')
      .reduce((ms, p) => ms + (new Date(p.ends_at).getTime() - Math.max(now, new Date(p.starts_at).getTime())), 0);
    const credit = Math.min(PLANS[target].priceCents, Math.round((PLANS.pro.priceCents * proMs) / YEAR_MS));
    return {
      kind: 'upgrade',
      amount_cents: Math.max(0, PLANS[target].priceCents - credit),
      credit_cents: credit,
      starts_at: new Date(now),
      ends_at: new Date(now + YEAR_MS),
    };
  }
  const start = Math.max(now, last);
  const kind = plan.key === 'free' && !periods.length ? 'new' : RANK[target] < RANK[plan.key] ? 'downgrade' : 'renew';
  return { kind, amount_cents: PLANS[target].priceCents, credit_cents: 0, starts_at: new Date(start), ends_at: new Date(start + YEAR_MS) };
}

/**
 * Turn one settled payment into a period, inside the webhook's transaction.
 * Timing is decided here, from the periods as they are when the money lands.
 */
export async function applyPurchase(tx, { userId, plan, kind, paymentId }) {
  await tx`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`;
  if (kind === 'upgrade') {
    await tx`delete from plan_periods where user_id = ${userId} and plan = 'pro' and starts_at > now()`;
    await tx`update plan_periods set ends_at = now() where user_id = ${userId} and plan = 'pro' and starts_at <= now() and ends_at > now()`;
    const [p] = await tx`
      insert into plan_periods (user_id, plan, starts_at, ends_at, payment_id)
      values (${userId}, ${plan}, now(), now() + interval '1 year', ${paymentId}) returning plan, starts_at, ends_at`;
    await setRenew(tx, userId, 'same');
    return p;
  }
  const [{ last }] = await tx`select greatest(now(), coalesce(max(ends_at), now())) as last from plan_periods where user_id = ${userId}`;
  const [p] = await tx`
    insert into plan_periods (user_id, plan, starts_at, ends_at, payment_id)
    values (${userId}, ${plan}, ${last}, ${last}::timestamptz + interval '1 year', ${paymentId}) returning plan, starts_at, ends_at`;
  // Paying for a plan is choosing it: renew as what was just bought.
  await setRenew(tx, userId, plan);
  return p;
}

export async function setRenew(sql, userId, renew) {
  await sql`
    insert into account_billing (user_id, renew, canceled_at, updated_at)
    values (${userId}, ${renew}, ${renew === 'none' ? new Date() : null}, now())
    on conflict (user_id) do update set renew = excluded.renew, canceled_at = excluded.canceled_at, updated_at = now()`;
}

/**
 * Accounts whose paid time runs out soon (or just did) and have not cancelled,
 * with the reminder each is due. `renewal_notices` makes it once per kind.
 */
export async function dueReminders(sql = db()) {
  return sql`
    with ends as (
      select p.user_id, max(p.ends_at) as period_end,
             (array_agg(p.plan order by p.ends_at desc))[1] as plan
      from plan_periods p group by p.user_id
    )
    select e.user_id, e.period_end, e.plan, u.email, coalesce(b.renew, 'same') as renew,
           case when e.period_end <= now() then 'ended'
                when e.period_end <= now() + interval '3 days' then '3d'
                else '14d' end as kind
    from ends e
    join users u on u.id = e.user_id and not u.is_admin
    left join account_billing b on b.user_id = e.user_id
    where coalesce(b.renew, 'same') <> 'none'
      and e.period_end <= now() + interval '14 days'
      and e.period_end > now() - interval '2 days'
      and not exists (
        select 1 from renewal_notices n where n.user_id = e.user_id and n.period_end = e.period_end
          and n.kind = case when e.period_end <= now() then 'ended'
                            when e.period_end <= now() + interval '3 days' then '3d' else '14d' end)`;
}

export async function markReminded(sql, { userId, periodEnd, kind }) {
  const rows = await sql`
    insert into renewal_notices (user_id, period_end, kind) values (${userId}, ${periodEnd}, ${kind})
    on conflict do nothing returning user_id`;
  return rows.length > 0;
}
