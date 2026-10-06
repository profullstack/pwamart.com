import { createHash, randomBytes } from 'node:crypto';
import { db, orgs } from '@pwamart/db';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { config } from './config.js';

/**
 * Magic link + passkey. No passwords. Ported from tleehealth (bg0ne before it).
 *
 * The emailed link proves the address, and the address is the account. Every
 * account gets a personal org on its way in (publishers and apps hang off orgs),
 * and an org invite sent to the address is accepted on sign-in, because the
 * emailed link already proved the address it was sent to.
 */

const TOKEN_TTL_MINUTES = 20;
const sha = (t) => createHash('sha256').update(t).digest();

export const rpName = 'pwamart';
// rpID comes from SITE_URL, not the request: a passkey made on one hostname does
// not exist on another, and the failure has no visible error.
export const rpID = () => new URL(config.siteUrl).hostname;
export const expectedOrigins = () => {
  const site = new URL(config.siteUrl);
  const host = site.hostname.replace(/^www\./, '');
  return [`${site.protocol}//${host}`, `${site.protocol}//www.${host}`];
};

/* -------------------------------------------------------------- magic link -- */

export async function createLoginLink(email) {
  const token = randomBytes(32).toString('base64url');
  await db()`
    insert into login_tokens (token_hash, email, expires_at)
    values (${sha(token)}, ${email.trim().toLowerCase()}, ${new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000)})`;
  return `${config.siteUrl}/auth/magic?t=${token}`;
}

/** Spend a link. An address nobody has used before gets an account. */
export async function consumeLoginLink(token, { userAgent } = {}) {
  const [row] = await db()`
    update login_tokens set used_at = now()
    where token_hash = ${sha(token)} and used_at is null and expires_at > now()
    returning email`;
  if (!row) return null;
  const user = await findOrCreateUser(row.email);
  return { user, sessionId: await startSession(user.id, userAgent) };
}

export async function findOrCreateUser(email) {
  const sql = db();
  const e = email.trim().toLowerCase();
  const [user] = await sql`
    insert into users (email) values (${e})
    on conflict (lower(email)) do update set email = users.email
    returning *`;
  await linkPeople(user);
  return user;
}

/**
 * The personal org, plus any pending invites to this address. Runs on every
 * sign-in, so an invite sent after the account existed is picked up next time.
 */
export async function linkPeople(user) {
  const sql = db();
  await orgs.ensurePersonalOrg(sql, { userId: user.id, name: user.email.split('@')[0] });
  const pending = await sql`
    select id, org_id, role from org_invites
    where lower(email) = ${user.email.toLowerCase()} and accepted_at is null and revoked_at is null and expires_at > now()`;
  for (const inv of pending) {
    // addMember upserts the role, so an owner invited again as a member would be demoted.
    if (!(await orgs.getMembership(sql, { orgId: inv.org_id, userId: user.id })))
      await orgs.addMember(sql, { orgId: inv.org_id, userId: user.id, role: inv.role });
    await sql`update org_invites set accepted_at = now(), accepted_by = ${user.id} where id = ${inv.id}`;
  }
}

/* ---------------------------------------------------------------- sessions -- */

async function startSession(userId, userAgent) {
  const id = randomBytes(32).toString('base64url');
  await db()`
    insert into sessions (id, user_id, user_agent, expires_at)
    values (${id}, ${userId}, ${userAgent ?? null}, ${new Date(Date.now() + config.session.ttlDays * 86400_000)})`;
  return id;
}

export async function userFromSession(sessionId) {
  if (!sessionId) return null;
  const [u] = await db()`
    select u.* from sessions s join users u on u.id = s.user_id
    where s.id = ${sessionId} and s.expires_at > now()`;
  return u ?? null;
}

export async function endSession(sessionId) {
  if (sessionId) await db()`delete from sessions where id = ${sessionId}`;
}

export function sessionCookie(sessionId, { clear = false } = {}) {
  const parts = [
    `${config.session.cookie}=${clear ? '' : sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${config.session.ttlDays * 86400}`,
  ];
  if (config.isProd) parts.push('Secure');
  return parts.join('; ');
}

/* ---------------------------------------------------------------- passkeys -- */

async function saveChallenge(challenge, userId = null) {
  const id = randomBytes(18).toString('base64url');
  await db()`
    insert into webauthn_challenges (id, challenge, user_id, expires_at)
    values (${id}, ${challenge}, ${userId}, ${new Date(Date.now() + 5 * 60_000)})`;
  return id;
}

async function takeChallenge(id) {
  if (!id) return null;
  const [row] = await db()`
    delete from webauthn_challenges where id = ${id} and expires_at > now() returning challenge, user_id`;
  return row ?? null;
}

export async function passkeyRegistrationOptions(user) {
  const existing = await db()`select credential_id, transports from passkeys where user_id = ${user.id}`;
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpID(),
    userName: user.email,
    userID: Buffer.from(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  return { options, challengeId: await saveChallenge(options.challenge, user.id) };
}

export async function verifyPasskeyRegistration({ user, response, challengeId }) {
  const ch = await takeChallenge(challengeId);
  if (!ch || ch.user_id !== user.id) return false;
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
  });
  if (!v.verified || !v.registrationInfo) return false;
  const { credential } = v.registrationInfo;
  await db()`
    insert into passkeys (credential_id, user_id, public_key, counter, transports)
    values (${credential.id}, ${user.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter},
            ${response.response?.transports ?? []})
    on conflict (credential_id) do nothing`;
  return true;
}

export async function passkeyAuthenticationOptions() {
  const options = await generateAuthenticationOptions({ rpID: rpID(), userVerification: 'preferred' });
  return { options, challengeId: await saveChallenge(options.challenge) };
}

export async function verifyPasskeyAuthentication({ response, challengeId, userAgent }) {
  const ch = await takeChallenge(challengeId);
  if (!ch) return null;
  const [stored] = await db()`select * from passkeys where credential_id = ${response?.id ?? ''}`;
  if (!stored) return null;
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: expectedOrigins(),
    expectedRPID: rpID(),
    credential: {
      id: stored.credential_id,
      publicKey: new Uint8Array(stored.public_key),
      counter: Number(stored.counter),
      transports: stored.transports,
    },
  });
  if (!v.verified) return null;
  await db()`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now()
             where credential_id = ${stored.credential_id}`;
  const [user] = await db()`select * from users where id = ${stored.user_id}`;
  await linkPeople(user);
  return { user, sessionId: await startSession(user.id, userAgent) };
}

/* ---------------------------------------------------------------- api keys -- */

const API_PREFIX = 'pm_live_';

export async function createApiKey({ userId, name = 'default' }) {
  const plaintext = `${API_PREFIX}${randomBytes(24).toString('base64url')}`;
  const [row] = await db()`
    insert into api_keys (user_id, name, key_hash, prefix)
    values (${userId}, ${name}, ${sha(plaintext)}, ${plaintext.slice(0, API_PREFIX.length + 6)})
    returning id, name, prefix, created_at`;
  return { ...row, key: plaintext };
}

export async function userFromApiKey(header) {
  const token = String(header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith(API_PREFIX)) return null;
  const [u] = await db()`
    update api_keys k set last_used_at = now() from users u
    where k.key_hash = ${sha(token)} and k.revoked_at is null and u.id = k.user_id
    returning u.*`;
  return u ?? null;
}
