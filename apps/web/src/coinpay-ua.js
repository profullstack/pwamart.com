import pkg from '../package.json' with { type: 'json' };

/**
 * User-Agent for server-side calls to CoinPay. Every fleet app shares one
 * public IP on dev2, so CoinPay's logs and throttle tell the apps apart by
 * this header instead of a bare `Bun/x.y.z`.
 */
export const COINPAY_UA = `pwamart.com/${pkg.version} (+https://pwamart.com)`;

/** fetch that adds COINPAY_UA unless the caller already set a User-Agent. */
export const coinpayFetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', COINPAY_UA);
  return fetch(input, { ...init, headers });
};
