import { Affiliates, hashCode as hashInvite, normalizeCode as normalizeInviteCode, postgresStore as affiliateStore } from '@profullstack/affiliates';
import { Credits, postgresStore as creditStore } from '@profullstack/redeem-credits';
import { db } from '@pwamart/db';
import { isDisposableEmail } from 'disposable-email-domains-js';
import { grantDays } from './billing.js';
import { config } from './config.js';

/**
 * Credit codes and invites, on two house packages over this store's Postgres.
 *
 * - @profullstack/redeem-credits mints scarce codes (stored only as hashes). A
 *   pwamart code grants `pro_days`: days of the Pro plan, written through the
 *   plan path a purchase takes (billing.js grantDays). The package's own ledger
 *   is only an audit trail here; nothing reads a balance from it.
 * - @profullstack/affiliates gives every account three single-use invites and an
 *   open ?ref= code. An accepted invite gives both people Pro days, but only for
 *   a NEW account whose address was confirmed (the emailed link was spent, or
 *   CoinPay vouched for it), after the checks in acceptInvite.
 */

export const CREDIT_UNIT = 'pro_days';
export const CODE_PREFIX = 'PM';
/** Invites per account. Scarce on purpose: an invite says someone wanted you here. */
export const INVITE_QUOTA = 3;
/** Where an /i/<code> visit is remembered until the person signs up. */
export const INVITE_COOKIE = 'pm_invite';
/** @profullstack/affiliates' REF_COOKIE (the @profullstack/referrals name); pwamart has no other referral program. */
export const REF_COOKIE = 'referral_code';
/** Bonuses one inviter can earn in 30 days, whatever their quota is raised to. */
export const INVITER_MONTHLY_CAP = 10;

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d;
};
/** Pro days each side of an accepted invite gets (INVITE_BONUS_DAYS; 0 turns the bonus off). */
export const bonusDays = () => num('INVITE_BONUS_DAYS', 30);
const inviterMinAgeHours = () => num('INVITER_MIN_AGE_HOURS', 24);

// postgres.js under the { query(text, params) -> { rows } } shape both stores take.
const pgLike = { query: async (text, params) => ({ rows: await db().unsafe(text, params ?? []) }) };

let services = null;
export function creditServices() {
  services ??= {
    credits: new Credits(creditStore(pgLike)),
    affiliates: new Affiliates(affiliateStore(pgLike), { defaultQuota: INVITE_QUOTA }),
  };
  return services;
}
/** Tests swap DATABASE_URL between files. */
export const resetCreditServices = () => {
  services = null;
};

/**
 * The origin to put in a link someone will share: SITE_URL in production, the
 * request's own origin when SITE_URL is still the localhost default.
 */
export function originFor(c) {
  const site = config.siteUrl;
  if (!/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(site)) return site;
  try {
    const u = new URL(c.req.url);
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? u.host;
    const proto = c.req.header('x-forwarded-proto') ?? u.protocol.replace(':', '');
    return `${proto}://${host}`;
  } catch {
    return site;
  }
}

/* ----------------------------------------------------------------- input -- */

/** A code as typed, or null when it cannot be one (junk, or long enough to be an attack on a log line). */
export function cleanCode(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t.length > 48 || !/^[A-Za-z0-9 _-]+$/.test(t)) return null;
  return t;
}

/** An affiliate code from ?ref= or the cookie: short, letters and digits. */
export function cleanRef(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return /^[A-Za-z0-9]{4,32}$/.test(t) ? t.toUpperCase() : null;
}

/** The canonical spelling of an invite, for a cookie and a URL; null when it cannot be one. */
export function canonicalInvite(value) {
  const c = cleanCode(value);
  if (!c) return null;
  const n = normalizeInviteCode(c);
  return /^INV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(n) ? n : null;
}

/**
 * One mailbox under two spellings: case, a +tag, and Gmail's dots. Inviting
 * yourself to collect both halves of a bonus is what this catches; a second
 * domain is not, and is what the monthly cap is for.
 */
export function sameMailbox(a, b) {
  const canonical = (email) => {
    const [rawLocal = '', rawDomain = ''] = String(email).trim().toLowerCase().split('@');
    let domain = rawDomain;
    let local = rawLocal.split('+')[0];
    if (domain === 'googlemail.com') domain = 'gmail.com';
    if (domain === 'gmail.com') local = local.replaceAll('.', '');
    return `${local}@${domain}`;
  };
  return canonical(a) === canonical(b);
}

/* ---------------------------------------------------------------- codes -- */

export const REDEEM_MESSAGES = {
  invalid: 'That code does not exist. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code has been withdrawn.',
};

/**
 * Redeem a code for Pro days. The package records the redemption first; the
 * Pro time is then written through grantDays, keyed on the code and the user,
 * so a failure in between heals on the next reconcile and never pays twice.
 */
export async function redeemCode(user, code) {
  const { credits } = creditServices();
  const r = await credits.redeem(code, user.id);
  if (!r.ok) return { ok: false, reason: r.reason, message: REDEEM_MESSAGES[r.reason] };
  if (r.grant.unit !== CREDIT_UNIT) return { ok: false, reason: 'invalid', message: 'That code is not for pwamart.' };
  const g = await db().begin((tx) => grantDays(tx, { userId: user.id, days: r.grant.amount, source: `code:${r.codeId}`, product: 'code' }));
  return { ok: true, days: r.grant.amount, plan: 'pro', starts_at: g.starts_at ?? null, ends_at: g.ends_at ?? null };
}

/**
 * Codes this account redeemed whose Pro time is missing (the grant failed after
 * the redemption committed). Re-applies each; grantDays makes it a no-op when
 * the time is already there.
 */
export async function reconcileCodes(userId) {
  creditServices();
  const rows = await db()`
    select l.source, l.amount from credit_ledger l
    where l.user_id = ${String(userId)} and l.kind = 'grant' and l.unit = ${CREDIT_UNIT} and l.source like 'code:%'
      and not exists (select 1 from payments p where p.provider = 'grant' and p.provider_ref = l.source || ':' || ${String(userId)})`.catch(
    (err) => (err?.code === '42P01' ? [] : Promise.reject(err)),
  );
  for (const r of rows)
    await db().begin((tx) => grantDays(tx, { userId, days: Number(r.amount), source: r.source, product: 'code' }));
  return rows.length;
}

/** What /api/v1/credits shows: every code and invite day this account got. */
export async function creditSummary(userId) {
  await reconcileCodes(userId);
  const grants = await db()`
    select p.created_at, coalesce(p.raw->'metadata'->>'product', 'code') as product, (p.raw->'metadata'->>'days')::int as days,
           pp.starts_at, pp.ends_at
    from payments p left join plan_periods pp on pp.payment_id = p.id
    where p.user_id = ${userId} and p.provider = 'grant' order by p.created_at desc limit 50`;
  return {
    unit: CREDIT_UNIT,
    plan: 'pro',
    days: grants.reduce((n, g) => n + (g.days ?? 0), 0),
    grants: grants.map((g) => ({ product: g.product, days: g.days, at: g.created_at, starts_at: g.starts_at, ends_at: g.ends_at })),
  };
}

/** Staff mint a code. The plaintext is in the result and nowhere else. */
export async function mintCode({ days, label, maxRedemptions = 1, expiresInDays = null, createdBy }) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3660) throw new RangeError('days must be a whole number from 1 to 3660');
  const max = Number(maxRedemptions);
  if (!Number.isInteger(max) || max < 1 || max > 10_000) throw new RangeError('max_redemptions must be a whole number from 1 to 10000');
  const exp = expiresInDays === null || expiresInDays === undefined || expiresInDays === '' ? null : Number(expiresInDays);
  if (exp !== null && (!Number.isFinite(exp) || exp <= 0)) throw new RangeError('expires_in_days must be a positive number');
  return creditServices().credits.mint({
    grant: { unit: CREDIT_UNIT, amount: n },
    label: String(label ?? '').trim().slice(0, 120) || `pwamart Pro ${n} days`,
    maxRedemptions: max,
    expiresAt: exp === null ? null : Date.now() + exp * 86_400_000,
    prefix: CODE_PREFIX,
    ...(createdBy ? { createdBy: String(createdBy) } : {}),
  });
}

/* -------------------------------------------------------------- invites -- */

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
const inviteView = (i) => ({
  id: i.id,
  note: i.note,
  created_at: iso(i.createdAt),
  expires_at: iso(i.expiresAt),
  used: i.usedBy !== null,
  used_at: iso(i.usedAt),
  revoked: (i.revokedAt ?? null) !== null,
});
export const inviteUrl = (origin, code) => `${origin}/i/${encodeURIComponent(code)}`;

export async function inviteSummary(userId, origin) {
  const { affiliates } = creditServices();
  const id = String(userId);
  const [quota, invites, affiliateCode, invitees] = await Promise.all([
    affiliates.quota(id),
    affiliates.invites(id),
    affiliates.affiliateCode(id),
    affiliates.invitees(id),
  ]);
  const [{ days }] = await db()`select coalesce(sum(days), 0)::int as days from invite_bonuses where user_id = ${userId} and status = 'granted'`;
  return {
    quota,
    invites: invites.map(inviteView),
    affiliate_code: affiliateCode,
    affiliate_url: `${origin}/?ref=${affiliateCode}`,
    invited: invitees.length,
    bonus_days: bonusDays(),
    bonus_days_earned: days,
  };
}

export async function createInvite(userId, note, origin) {
  const { affiliates } = creditServices();
  try {
    const invite = await affiliates.createInvite(String(userId), String(note ?? '').trim().slice(0, 120));
    return { ok: true, code: invite.code, url: inviteUrl(origin, invite.code), invite: inviteView(invite), quota: await affiliates.quota(String(userId)) };
  } catch (err) {
    if (/no invites left/i.test(err?.message ?? '')) return { ok: false, reason: 'no_invites_left' };
    throw err;
  }
}

/** Revoke one of your own unused invites (the slot comes back). */
export async function revokeInvite(userId, inviteId) {
  const { affiliates } = creditServices();
  const mine = (await affiliates.invites(String(userId))).find((i) => i.id === inviteId);
  if (!mine) return { ok: false, status: 404, error: 'no such invite' };
  if (mine.usedBy !== null) return { ok: false, status: 409, error: 'that invite was already used' };
  await affiliates.revokeInvite(inviteId);
  return { ok: true, quota: await affiliates.quota(String(userId)) };
}

/** Whether an invite code can still be accepted, for the /i/<code> page. Spends nothing. */
export async function inviteState(code) {
  const canonical = canonicalInvite(code);
  if (!canonical) return 'invalid';
  // Read-only peek at the package's table (no store method answers this without spending the invite).
  const [row] = await db()`select used_by, revoked_at, expires_at from aff_invites where code_hash = ${hashInvite(canonical)}`.catch(() => []);
  if (!row) return 'invalid';
  if (row.revoked_at !== null) return 'revoked';
  if (row.used_by !== null) return 'used';
  if (row.expires_at !== null && Number(row.expires_at) <= Date.now()) return 'expired';
  return 'ok';
}

/**
 * Accept an invite for an account this sign-in just created. The address is
 * confirmed by construction (the caller is the magic-link or CoinPay callback).
 * The invite is spent whatever the bonus decides: who invited whom is recorded
 * even when nothing is paid for it.
 */
export async function acceptInvite(code, invitee) {
  const { affiliates } = creditServices();
  // One invite per account, checked before the package spends a second one.
  if (await affiliates.invitedBy(String(invitee.id))) return { invite: { ok: false, reason: 'already_invited' }, bonus: null, days: 0 };
  const invite = await affiliates.redeemInvite(code, String(invitee.id));
  if (!invite.ok) return { invite, bonus: null, days: 0 };

  const days = bonusDays();
  const [inviter] = await db()`
    select u.id, u.email, u.is_admin, extract(epoch from (now() - u.created_at)) / 3600 as age_hours,
           (select count(*)::int from invite_bonuses b where b.user_id = u.id and b.role = 'inviter' and b.status = 'granted'
              and b.created_at > now() - interval '30 days') as recent
    from users u where u.id::text = ${invite.inviterId}`;

  let status = 'granted';
  if (days <= 0 || !inviter) status = 'disabled';
  else if (isDisposableEmail(invitee.email)) status = 'disposable';
  else if (sameMailbox(inviter.email, invitee.email)) status = 'same_mailbox';
  else if (Number(inviter.age_hours) < inviterMinAgeHours()) status = 'inviter_too_new';
  else if (inviter.recent >= INVITER_MONTHLY_CAP) status = 'inviter_cap';

  const pairs = [[invitee.id, 'invitee']];
  // Staff are unlimited already; the person they invited still gets the days.
  if (inviter) pairs.push([inviter.id, 'inviter']);
  let paid = 0;
  for (const [userId, role] of pairs) {
    const pay = status === 'granted' && !(role === 'inviter' && inviter.is_admin);
    await db().begin(async (tx) => {
      // Claimed first, in the same transaction as the grant: a retry never pays twice.
      const [claimed] = await tx`
        insert into invite_bonuses (invite_id, user_id, role, days, status)
        values (${invite.inviteId}, ${userId}, ${role}, ${pay ? days : 0}, ${pay ? 'granted' : status === 'granted' ? 'staff' : status})
        on conflict do nothing returning invite_id`;
      if (!claimed || !pay) return;
      await grantDays(tx, { userId, days, source: `invite:${invite.inviteId}:${role}`, product: 'invite' });
      if (role === 'invitee') paid = days;
    });
  }
  return { invite, bonus: status, days: paid };
}

/** First touch: an account already attributed keeps its first affiliate. */
export async function attributeRef(ref, userId) {
  const code = cleanRef(ref);
  if (!code) return { ok: false };
  return creditServices().affiliates.attribute(code, String(userId));
}

/**
 * Everything a brand-new account picks up on its way in: the invite and the ?ref=
 * it arrived with. Never throws: a sign-in must not fail over a bonus.
 */
export async function welcomeNewAccount(user, { invite, ref } = {}) {
  const out = {};
  try {
    const code = canonicalInvite(invite);
    if (code) out.invite = await acceptInvite(code, user);
  } catch (err) {
    console.error(`[invites] accept failed for ${user.id}: ${err?.message ?? err}`);
  }
  try {
    if (cleanRef(ref)) out.ref = await attributeRef(ref, user.id);
  } catch (err) {
    console.error(`[invites] ref attribution failed for ${user.id}: ${err?.message ?? err}`);
  }
  return out;
}
