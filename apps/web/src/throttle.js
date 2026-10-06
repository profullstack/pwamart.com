import { createThrottle } from '@profullstack/throttle';
import { createGateway } from '@profullstack/x402-gateway';
import { config } from './config.js';

/**
 * The fleet's crawl gateway + app-wide throttle (house packages, same as every
 * other site): a training crawler pays for a day pass at /crawl over x402, and
 * any caller past 100 requests a minute gets a 402 with that pass on offer
 * instead of a bare 429. Readers, search engines and AI answer crawlers are free.
 *
 * COINPAY_X402_KEY is pwamart's own scoped key ("x402 crawl passes", business
 * e34834dd); CRAWL_PAY_TO is the fleet's USDC address. Without the key the
 * gateway is off and the throttle answers 429, so nothing breaks locally.
 */

const OPEN = [
  '/healthz',
  '/api/v1/health',
  '/webhooks/',
  '/assets/',
  '/badges/',
  '/sw.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/favicon.svg',
  '/logo.svg',
  '/install.sh',
  '/upgrade.sh',
  '/uninstall.sh',
];

let built = null;
function build() {
  const apiKey = process.env.COINPAY_X402_KEY;
  const gateway = apiKey
    ? createGateway({ siteUrl: config.siteUrl, coinpay: { apiKey }, payTo: process.env.CRAWL_PAY_TO })
    : null;
  const throttle = createThrottle({
    gateway,
    limit: Number(process.env.THROTTLE_LIMIT ?? 100),
    // A signed-in browser or an API/OAuth key is one integration, not one scraper:
    // it gets the credentialed budget (the per-address ceiling still applies).
    credentialFrom: (request) => {
      const auth = request.headers.get('authorization');
      if (auth) return auth;
      const cookie = request.headers.get('cookie') ?? '';
      const m = cookie.match(new RegExp(`(?:^|;\\s*)${config.session.cookie}=([^;]+)`));
      return m ? m[1] : null;
    },
    rules: [
      ...OPEN.map((path) => ({ path, open: true })),
      // Brute-force and spam shaped routes stay per-address whatever they present.
      { path: '/api/v1/auth/', limit: 10, credential: false },
      { path: '/api/v1/follow', limit: 20, credential: false },
      { path: '/api/v1/inspect', limit: 20 },
      { path: '/api/v1/newsletter/', limit: 10, credential: false },
      { path: '/oauth/token', limit: 30, credential: false },
      { path: '/oauth/authorize', limit: 30, credential: false },
    ],
  });
  return { gateway, throttle };
}

/** Hono middleware: crawl gateway first (a declared crawler pays by its list), then the throttle. */
export function trafficGuard() {
  return async (c, next) => {
    if (process.env.THROTTLE === 'off') return next();
    built ??= build();
    if (built.gateway) {
      const sold = await built.gateway.handle(c.req.raw);
      if (sold) return sold;
    }
    const answer = await built.throttle.handle(c.req.raw);
    if (answer) return answer;
    return next();
  };
}

/** Tests rebuild with new env. */
export const resetTrafficGuard = () => {
  built = null;
};
