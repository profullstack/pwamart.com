import { randomBytes } from 'node:crypto';
import { db } from '@pwamart/db';
import {
  exchangeCoinPayCode,
  fetchCoinPayUserinfo,
  generateCoinPayPkcePair,
  getCoinPayAuthorizeUrl,
  validateCoinPayState,
} from '@profullstack/stack/coinpay';
import { getCookie } from 'hono/cookie';
import * as auth from './auth.js';
import { config } from './config.js';
import { INVITE_COOKIE, REF_COOKIE, welcomeNewAccount } from './credits.js';

/**
 * Sign in with CoinPay: the house identity provider (OIDC at coinpayportal.com,
 * authorization code + PKCE), through the shared @profullstack/stack/coinpay helpers.
 *
 * Linking is by `sub` (the CoinPay DID) only, never by email: CoinPay does not
 * verify emails. So: a returning sub signs in; a signed-in user who connects gets
 * the sub attached; an email that already belongs to an account is NOT taken over:
 * that person signs in by email and connects.
 *
 * A new CoinPay account never gets CoinPay's email as its own address: users.email
 * is what magic links, ADMIN_EMAILS and org invites trust, so it holds only an
 * address this site proved. The account gets <sub>@coinpay.pwamart.com instead.
 */

/** The address a CoinPay-created account carries: never a real, unproven one. */
export const COINPAY_EMAIL_DOMAIN = 'coinpay.pwamart.com';
export const placeholderEmail = (sub) => `${String(sub).replace(/[^a-z0-9]/gi, '').slice(-24).toLowerCase()}@${COINPAY_EMAIL_DOMAIN}`;

const COOKIE = 'pm_cp';
const SCOPES = 'openid profile email did';
let fetchImpl = fetch;
/** Tests swap CoinPay for a fake. */
export const setCoinPayFetch = (f) => {
  fetchImpl = f;
};

const enabled = () => Boolean(config.coinpayOAuth.clientId && config.coinpayOAuth.clientSecret);
const redirectUri = () => `${config.siteUrl}/api/v1/coinpay/callback`;
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/console');
const cookieAttrs = () => `Path=/api/v1/coinpay; HttpOnly; SameSite=Lax; Max-Age=600${config.isProd ? '; Secure' : ''}`;

export function mountCoinPaySignin(app) {
  app.get('/api/v1/coinpay/login', (c) => {
    if (!enabled()) return c.redirect('/signin?error=coinpay-off', 302);
    const state = randomBytes(24).toString('base64url');
    const { codeVerifier, codeChallenge } = generateCoinPayPkcePair();
    const next = safeNext(c.req.query('next'));
    const payload = Buffer.from(JSON.stringify({ state, codeVerifier, next })).toString('base64url');
    c.header('set-cookie', `${COOKIE}=${payload}; ${cookieAttrs()}`);
    return c.redirect(
      getCoinPayAuthorizeUrl({ issuer: config.coinpayOAuth.issuer, clientId: config.coinpayOAuth.clientId, redirectUri: redirectUri(), state, codeChallenge, scopes: SCOPES }),
      302,
    );
  });

  app.get('/api/v1/coinpay/callback', async (c) => {
    const fail = (why) => c.redirect(`/signin?error=${encodeURIComponent(why)}`, 302);
    let saved;
    try {
      saved = JSON.parse(Buffer.from(getCookie(c, COOKIE) ?? '', 'base64url').toString());
    } catch {
      return fail('coinpay-expired');
    }
    c.header('set-cookie', `${COOKIE}=; ${cookieAttrs().replace('Max-Age=600', 'Max-Age=0')}`);
    if (c.req.query('error')) return fail('coinpay-denied');
    if (!validateCoinPayState(c.req.query('state'), saved?.state)) return fail('coinpay-state');

    let claims;
    try {
      const tokens = await exchangeCoinPayCode({
        issuer: config.coinpayOAuth.issuer,
        code: c.req.query('code'),
        redirectUri: redirectUri(),
        clientId: config.coinpayOAuth.clientId,
        clientSecret: config.coinpayOAuth.clientSecret,
        codeVerifier: saved.codeVerifier,
        fetch: fetchImpl,
      });
      claims = await fetchCoinPayUserinfo({ issuer: config.coinpayOAuth.issuer, accessToken: tokens.access_token, fetch: fetchImpl });
    } catch (err) {
      console.error(`[coinpay-signin] ${err.message}`);
      return fail('coinpay-failed');
    }
    if (!claims?.sub) return fail('coinpay-failed');
    const sql = db();
    const current = await auth.userFromSession(getCookie(c, config.session.cookie));

    let user;
    if (current) {
      // Connecting CoinPay to the signed-in account.
      const [owner] = await sql`select id from users where coinpay_sub = ${claims.sub}`;
      if (owner && owner.id !== current.id) return c.redirect('/console/keys?coinpay=taken', 302);
      await sql`update users set coinpay_sub = ${claims.sub} where id = ${current.id}`;
      return c.redirect(saved.next === '/console' ? '/console/keys?coinpay=connected' : saved.next, 302);
    }
    [user] = await sql`select * from users where coinpay_sub = ${claims.sub}`;
    if (!user) {
      const email = String(claims.email ?? '').trim().toLowerCase();
      if (email) {
        const [taken] = await sql`select id from users where lower(email) = ${email}`;
        if (taken) return fail('coinpay-email-exists');
      }
      [user] = await sql`
        insert into users (email, name, coinpay_sub)
        values (${placeholderEmail(claims.sub)}, ${claims.name ?? null}, ${claims.sub})
        returning *`;
      await auth.linkPeople(user);
      // A new account: CoinPay vouched for it, so it takes the invite and ?ref= this browser carried.
      await welcomeNewAccount(user, { invite: getCookie(c, INVITE_COOKIE), ref: getCookie(c, REF_COOKIE) });
      c.header('set-cookie', `${INVITE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`, { append: true });
    }
    const sessionId = await auth.startSessionFor(user.id, c.req.header('user-agent'));
    c.header('set-cookie', auth.sessionCookie(sessionId), { append: true });
    return c.redirect(safeNext(saved.next), 302);
  });
}
