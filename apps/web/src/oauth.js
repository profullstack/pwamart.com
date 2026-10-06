import { createOAuthServer, OAuthError } from '@profullstack/auth-system/oauth2';
import { postgresStore } from '@profullstack/auth-system/oauth2/postgres';
import { db } from '@pwamart/db';
import { getCookie } from 'hono/cookie';
import * as auth from './auth.js';
import { config } from './config.js';
import { e, layout } from './pages.js';

/**
 * OAuth 2.1 for pwamart's own clients, from the shared house implementation
 * (@profullstack/auth-system/oauth2): `pwamart login` in the CLI, and through
 * its token file the TUI and the stdio MCP server. Authorization code + PKCE S256,
 * loopback redirects, rotating refresh tokens. Access tokens look like pm_at_….
 *
 * The consent page needs a signed-in browser session; someone who is not signed
 * in goes through /signin (magic link, passkey) and comes back here.
 */

const CLIENTS = () => ({
  'pwamart-cli': {
    name: 'pwamart CLI, TUI and MCP',
    redirectUris: ['http://127.0.0.1/callback', 'http://localhost/callback', `${config.siteUrl}/oauth/cli`],
  },
});

let server = null;
export function oauth() {
  server ??= createOAuthServer({
    store: postgresStore(db()),
    clients: CLIENTS(),
    issuer: config.siteUrl,
    tokenPrefix: 'pm',
    scopes: ['read', 'write'],
  });
  return server;
}

/** Bearer pm_at_… -> the user row, or null. */
export async function userFromAccessToken(header) {
  const who = await oauth().verifyAccessToken(header);
  if (!who) return null;
  const [u] = await db()`select * from users where id::text = ${who.userId}`;
  return u ?? null;
}

const form = async (c) => {
  const type = c.req.header('content-type') ?? '';
  if (type.includes('application/json')) return c.req.json().catch(() => ({}));
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
};

const oauthErrorPage = (c, err) =>
  c.html(
    layout({
      title: 'Sign-in request refused',
      noindex: true,
      body: `<div class="wrap"><section class="block" style="padding:70px 0;max-width:620px"><div class="eyebrow">OAuth</div><h1 style="margin:10px 0 14px;font-size:40px">That sign-in request is not valid.</h1><p class="lede">${e(err.message)}</p><a class="btn" href="/">Back to the store</a></section></div>`,
    }),
    400,
  );

export function mountOAuth(app) {
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(oauth().metadata()));

  app.get('/oauth/authorize', async (c) => {
    let p;
    try {
      p = oauth().validateAuthorize(c.req.query());
    } catch (err) {
      return oauthErrorPage(c, err);
    }
    const user = await auth.userFromSession(getCookie(c, config.session.cookie));
    if (!user) return c.redirect(`/signin?next=${encodeURIComponent(c.req.url.replace(/^https?:\/\/[^/]+/, ''))}`, 302);
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost)/.test(p.redirectUri);
    const hidden = Object.entries(c.req.query())
      .map(([k, v]) => `<input type="hidden" name="${e(k)}" value="${e(v)}">`)
      .join('');
    return c.html(
      layout({
        title: 'Allow access',
        noindex: true,
        body: `<div class="wrap"><section class="block" style="padding:60px 0;max-width:560px;margin:0 auto">
          <div class="eyebrow">Sign in</div>
          <h1 style="margin:10px 0 14px;font-size:42px">Allow <em style="color:var(--orange)">${e(p.clientName)}</em>?</h1>
          <p class="lede" style="font-size:17px">It will act as <b>${e(user.email)}</b> on pwamart: ${p.scope.includes('write') ? 'read your account and manage your publishers and apps' : 'read your account'}.
          ${loopback ? 'It is waiting on this computer.' : 'You will get a code to paste back into it.'}</p>
          <form method="post" action="/oauth/authorize" class="panel" style="display:grid;gap:12px;margin-top:18px">
            ${hidden}
            <div class="row" style="display:flex;gap:10px">
              <button class="btn primary" name="decision" value="allow">Allow</button>
              <button class="btn" name="decision" value="deny">Deny</button>
            </div>
            <p class="muted" style="font-size:13px;margin:0">Revoke it any time with <code>pwamart logout</code>, or every sign-in from the console.</p>
          </form></section></div>`,
      }),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    // A cross-site form post cannot ride the Lax session cookie, and we check the origin too.
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(config.siteUrl).origin) return c.text('cross-site request refused', 403);
    const user = await auth.userFromSession(getCookie(c, config.session.cookie));
    if (!user) return c.redirect('/signin', 302);
    const b = await form(c);
    let p;
    try {
      p = oauth().validateAuthorize(b);
    } catch (err) {
      return oauthErrorPage(c, err);
    }
    if (b.decision !== 'allow') return c.redirect(oauth().denyUrl(p), 302);
    return c.redirect(await oauth().approve({ ...p, userId: user.id }), 302);
  });

  app.post('/oauth/token', async (c) => {
    try {
      const tokens = await oauth().token(await form(c));
      return c.json(tokens, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    } catch (err) {
      if (err instanceof OAuthError) return c.json(err.toJSON(), err.status ?? 400, { 'cache-control': 'no-store' });
      console.error('[oauth] token', err);
      return c.json({ error: 'server_error' }, 500);
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const b = await form(c);
    await oauth().revoke(b.token).catch(() => {});
    return c.json({}, 200);
  });

  // Headless sign-in (SSH): the browser lands here and shows the code to paste back.
  app.get('/oauth/cli', (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const err = c.req.query('error');
    const body = err
      ? `<h1 style="margin:10px 0 14px;font-size:40px">Sign-in ${e(err.replace(/_/g, ' '))}.</h1><p class="lede">Nothing was shared. Run <code>pwamart login</code> again if you meant to.</p>`
      : `<h1 style="margin:10px 0 14px;font-size:40px">Paste this into your terminal</h1>
         <pre style="font:16px var(--mono);background:var(--paper-2);border:1px solid var(--line);border-radius:12px;padding:16px;overflow-x:auto" id="code">${e(code)}#${e(state)}</pre>
         <p class="muted">It works once and expires in 5 minutes.</p>`;
    return c.html(layout({ title: 'pwamart CLI sign-in', noindex: true, body: `<div class="wrap"><section class="block" style="padding:60px 0;max-width:640px;margin:0 auto"><div class="eyebrow">pwamart CLI</div>${body}</section></div>` }));
  });
}
