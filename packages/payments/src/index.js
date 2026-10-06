import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * CoinPay: taking money, and turning exactly one settled payment into access.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS SHARED VERBATIM BETWEEN BRANDS. Do not import a brand package.
 * ---------------------------------------------------------------------------
 *
 * Every other package here imports its own brand's db and config by name, which is
 * exactly what stops a file being copied between siblings: one source cannot name
 * two different scopes. So this one imports nothing but node:crypto and is handed
 * what it needs once, at boot, by whichever app is starting.
 *
 * That is the whole reason for `configurePayments`. It is not a testing seam or a
 * fashion -- it is what lets `cp packages/payments/src/index.js` be the entire port
 * between siblings, now and every time this changes again.
 *
 * The module is also deliberately narrow. It can start a payment, verify a
 * webhook, and settle one. It knows nothing about what is being sold and nothing
 * about how much of it there is. Anything brand-specific arrives as a callback
 * from the caller, which is what keeps "what is for sale" out of a file that is
 * copied around.
 */

/* ------------------------------------------------------------------- wiring -- */

/** @type {{sql: Function, coinpay: object, siteUrl: string} | null} */
let deps = null;

/**
 * Hand the module its brand's database handle and settings. Called once at boot.
 *
 * `coinpay` is passed as the OBJECT rather than as unpacked values, and that is
 * load-bearing: its api key, business id and webhook secret are getters that read
 * the environment on every access. Snapshotting them here would reintroduce the
 * bug their comment in config warns about, where the value depended on which
 * module imported config first and the signature tests became a coin flip decided
 * by the rest of the suite.
 *
 * @param {{sql: Function, coinpay: object, siteUrl: string}} injected
 */
export function configurePayments(injected) {
  deps = injected;
}

function need() {
  if (!deps) {
    // A clear sentence, because the alternative is `undefined is not a function`
    // three frames into a webhook at two in the morning.
    throw new Error('configurePayments() has not been called; wire it up at boot');
  }
  return deps;
}

/** Whether money can be taken at all. Every caller checks this before offering to. */
export function paymentsEnabled() {
  return Boolean(deps?.coinpay?.enabled);
}

/**
 * Constant-time hex compare.
 *
 * Inlined rather than imported from the brand's auth package -- four lines is a
 * cheaper price than a scoped import in a file that has to be copyable.
 * Variable-time comparison of a signature is how a forgery gets found one byte at
 * a time.
 */
function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/* ----------------------------------------------------------------- checkout -- */

/**
 * Start a payment and write it down as pending.
 *
 * Nothing here knows what is being bought. `description` is what the buyer reads
 * on the checkout page and `metadata` is echoed back on the webhook -- and that
 * echo is the only thing linking money to a purchase, so a settled payment with
 * empty metadata cannot be attributed to anything and is unrecoverable without a
 * human.
 *
 * The pending row is inserted BEFORE the buyer leaves. A webhook can arrive before
 * the redirect completes, and settling a payment we have no record of would mean
 * dropping money that genuinely arrived.
 *
 * @param {object} args
 * @param {{id: string}} args.user
 * @param {number} args.amountCents
 * @param {string} [args.currency]
 * @param {string} args.description  shown to the buyer on the checkout page
 * @param {Record<string,string>} args.metadata  echoed back on the webhook
 * @param {string} args.blockchain  chain to settle on, e.g. BTC or ETH
 * @param {string} [args.paymentMethod]  crypto (default), card, or both
 * @param {string} [args.payTo]  override the payee; omit to use the business wallet
 * @param {string} [args.successUrl]
 * @param {string} [args.cancelUrl]
 * @returns {Promise<{checkoutUrl: string, paymentRef: string}>}
 */
export async function createCheckout({
  user,
  amountCents,
  currency = 'USD',
  description,
  metadata = {},
  blockchain,
  paymentMethod = 'crypto',
  payTo,
  successUrl,
  cancelUrl,
}) {
  const { sql, coinpay } = need();
  if (!coinpay.enabled) throw new Error('CoinPay is not configured');
  if (!user?.id) throw new Error('a checkout needs a buyer');
  if (!Number.isFinite(amountCents) || amountCents < 0) throw new Error('bad amount');

  /*
   * A crypto payment has to name the chain it settles on.
   *
   * The upstream refuses without it -- "Invalid or missing cryptocurrency type" --
   * so omitting it does not settle somewhere sensible by default, it simply fails
   * at the moment a buyer presses pay. Named here so the failure is at the call
   * site instead.
   */
  const needsCrypto = paymentMethod !== 'card';
  if (needsCrypto && !blockchain) throw new Error('a crypto checkout needs a blockchain');

  /*
   * WHERE THE MONEY GOES: omit payTo, and the upstream resolves it.
   *
   * `merchant_wallet_address` is an OVERRIDE, not a requirement. Left out, the
   * upstream forwards to the business's own wallet for that chain, falling back to
   * the account-global one -- and if neither exists it refuses the payment with
   * "No <coin> wallet configured for this business" rather than settling anywhere.
   * That is the correct behaviour and it is per-chain, which a single address in
   * configuration could never be: a BTC address is not a payee for an ETH payment.
   *
   * So the payee is attached to the BUSINESS (import the account-global wallets
   * once) and not carried in every call. The override exists for the genuinely
   * third-party case -- forwarding the net to somebody who is not the business --
   * and the upstream records who authorised it.
   */

  const res = await fetch(`${coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${coinpay.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      business_id: coinpay.businessId,
      amount: amountCents / 100,
      currency,
      blockchain,
      payment_method: paymentMethod,
      ...(payTo ? { merchant_wallet_address: payTo } : {}),
      description,
      // Always carries the buyer. A caller may add whatever else identifies the
      // purchase; settleWebhook hands the whole object back to the grant callback.
      metadata: { ...metadata, user_id: user.id },
      success_url: successUrl,
      cancel_url: cancelUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) throw new Error(`coinpay ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();

  /*
   * The payment is nested, and the id is what the webhook will echo.
   *
   * The response is { success, payment: {...}, usage } -- reading `body.id` finds
   * nothing, so the pending row would be written under an undefined reference and
   * the webhook could never match it.
   */
  const payment = body?.payment ?? body;
  const ref = payment?.id ?? payment?.payment_id;
  if (!ref) throw new Error('coinpay returned no payment reference');

  await sql`
    insert into payments ${sql({
      user_id: user.id,
      provider: 'coinpay',
      provider_ref: ref,
      amount_cents: amountCents,
      currency,
      status: 'pending',
      raw: body,
    })}
    on conflict (provider, provider_ref) do nothing
  `;

  /*
   * Where to send the buyer.
   *
   * A card payment comes back with a Stripe session URL. A crypto one does not --
   * it comes back with an address and an amount, and the page that renders those
   * is the hosted checkout at /pay/<id>. There is no generic `checkout_url` field;
   * reading one is how this returned undefined and sent buyers nowhere.
   */
  const checkoutUrl = payment?.stripe_checkout_url ?? `${coinpay.baseUrl}/pay/${ref}`;
  return { checkoutUrl, paymentRef: ref };
}

/* ------------------------------------------------------------------ webhook -- */

/**
 * Verify a CoinPay webhook signature.
 *
 * Signed over the RAW request bytes. Re-serialising the parsed JSON changes key
 * order and whitespace and the signature stops matching -- which reads as a forged
 * request rather than the bug it is, so every caller must hand this the body it
 * received rather than one it rebuilt.
 *
 * The timestamp window is what stops a captured webhook being replayed later; the
 * signature alone proves origin, not freshness.
 */
export function verifyWebhook({ rawBody, signatureHeader, toleranceSeconds = 300 }) {
  const { coinpay } = need();
  if (!signatureHeader || !coinpay.webhookSecret) return false;

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((kv) => kv.split('=').map((s) => s.trim())),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', coinpay.webhookSecret)
    .update(`${parts.t}.${rawBody}`)
    .digest('hex');

  try {
    return safeEqualHex(expected, v1);
  } catch {
    // A malformed v1 that is not valid hex throws in Buffer.from. That is a no.
    return false;
  }
}

/**
 * Statuses that mean money actually arrived.
 *
 * A webhook fires for failures and cancellations too, and granting on any VERIFIED
 * webhook is the mistake this set exists to prevent: the signature proves the
 * message is genuine, never that it says yes.
 */
const SETTLED = new Set(['paid', 'completed', 'confirmed', 'succeeded', 'settled']);

/**
 * Pull the payment out of a webhook body, whichever envelope it arrived in.
 *
 * THE LIVE SHAPE IS NESTED, and this file used to read it flat. CoinPay sends:
 *
 *   { id: "evt_<paymentId>_<unixTs>",
 *     type: "payment.confirmed",
 *     data: { payment_id, status, amount, amount_usd, metadata, ... },
 *     created_at, business_id }
 *
 * The top-level `id` is the EVENT, not the payment. Reading `payload.id`,
 * `payload.status` and `payload.metadata` -- which is what stood here -- resolved
 * the reference to `evt_...`, found no status and no metadata, and threw
 * "webhook missing metadata" on every genuine confirmation. It failed inside a
 * webhook handler, so the only symptom was that crypto payments never settled.
 *
 * The tests did not catch it because they were written against the flat shape
 * too, which is worth remembering: a test that encodes the same wrong assumption
 * as the code confirms the bug rather than finding it. The nested shape here is
 * copied from the sender, `src/lib/webhooks/service.ts` in coinpayportal.
 *
 * Reading the flat fields FIRST would be worse than throwing: against a real
 * webhook it matches the event id and would settle against a reference that
 * belongs to nothing. So `data` wins wherever it exists, and the flat shape stays
 * supported because the older test-webhook sender still uses it.
 *
 * @param {object} payload the parsed webhook body
 * @returns {{ref: string, status: string, meta: object, event: string}}
 */
export function readWebhook(payload) {
  const data = payload?.data ?? payload;
  const ref = data?.payment_id ?? data?.id;
  const status = String(data?.status ?? '').toLowerCase();
  const meta = data?.metadata ?? payload?.metadata ?? {};
  const event = String(payload?.type ?? payload?.event ?? '');
  return { ref, status, meta, event };
}

/**
 * Record what a webhook says and, if money arrived, grant access -- atomically.
 *
 * The grant is a callback because what is being sold differs per brand and this
 * file does not get to know. It runs inside the SAME transaction as the payment
 * update, which is what makes the whole thing one decision: a caller that checks
 * what is left first and writes afterwards has the classic oversell, where two
 * buyers pass the check together and both are sold the last one.
 *
 * `grant` receives the transaction, so any conditional UPDATE it needs is
 * serialised with everything else here. It also receives the payment row as WE
 * recorded it at checkout -- amount included -- rather than as the payload claims
 * it: anything calculated from the money (a commission, a tier) must be a
 * percentage of what we charged, not of a number that arrived over the wire.
 * Returning a falsy value aborts the grant without failing the webhook: the money
 * is recorded, the access is not given, and the caller decides what to say.
 *
 * Idempotent by construction. `payments` is unique on (provider, provider_ref), so
 * a replayed webhook updates the same row, and any sane grant is an upsert -- see
 * the entitlement helper below.
 *
 * @param {object} payload the parsed webhook body
 * @param {{grant?: (tx: Function, ctx: object) => Promise<any>}} [handlers]
 */
export async function settleWebhook(payload, { grant } = {}) {
  const { sql } = need();

  const { meta, ref, status } = readWebhook(payload);

  if (!ref) throw new Error('webhook missing payment reference');
  if (!meta.user_id) throw new Error('webhook missing metadata');

  return sql.begin(async (tx) => {
    const [payment] = await tx`
      update payments set status = ${status || 'unknown'}, raw = ${payload}, updated_at = now()
      where provider = 'coinpay' and provider_ref = ${ref}
      returning id, status, amount_cents, currency
    `;

    if (!SETTLED.has(status)) return { settled: false, granted: false, reason: `status ${status}` };
    if (!grant) return { settled: true, granted: false, reason: 'nothing to grant' };

    const result = await grant(tx, { meta, payment, payload });
    return result
      ? { settled: true, granted: true, result }
      : { settled: true, granted: false, reason: 'grant declined' };
  });
}

/* ------------------------------------------------------------- entitlements -- */

/**
 * Grant one person access to one event, inside a caller's transaction.
 *
 * Offered as a helper rather than done automatically, because a brand may be
 * selling something that is not an event at all. Both brands have an `events`
 * table keyed by bigint, which is what makes this shape shared rather than
 * borrowed.
 *
 * `on conflict do nothing`: re-buying is a no-op rather than a second charge or a
 * second row, and a replayed webhook cannot extend anybody's access.
 */
export async function grantEventEntitlement(
  tx,
  { userId, eventId, offerId = null, paymentId = null, expiresAt },
) {
  if (!userId || !Number.isFinite(Number(eventId))) throw new Error('bad entitlement');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    // An open-ended grant to a stream is the thing that turns a small sale into
    // redistribution, so there is no default here and no way to omit it.
    throw new Error('an entitlement needs an expiry');
  }

  await tx`
    insert into entitlements ${tx({
      user_id: userId,
      event_id: Number(eventId),
      offer_id: offerId,
      payment_id: paymentId,
      status: 'active',
      expires_at: expiresAt,
    })}
    on conflict (user_id, event_id) do nothing
  `;
  return { eventId: Number(eventId), expiresAt };
}

/** What this person currently holds for this event, if anything. */
export async function activeEntitlement({ userId, eventId }) {
  const { sql } = need();
  if (!userId || !eventId) return null;
  const [row] = await sql`
    select * from entitlements
    where user_id = ${userId} and event_id = ${eventId}
      and status = 'active' and expires_at > now()
  `;
  return row ?? null;
}

/** Everything this person currently holds. For an account page. */
export async function activeEntitlements(userId) {
  const { sql } = need();
  if (!userId) return [];
  return sql`
    select * from entitlements
    where user_id = ${userId} and status = 'active' and expires_at > now()
    order by expires_at
  `;
}
