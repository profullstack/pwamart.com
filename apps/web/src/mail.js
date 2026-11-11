import { promoBlock } from '@profullstack/cross-promo';
import { config } from './config.js';

/**
 * Email through Resend over plain fetch. With no key configured (local, tests)
 * the message is logged instead, so sign-in still works on a dev box.
 */
export async function send({ to, subject, text }) {
  if (!config.mail.enabled) {
    console.log(`[mail] (not sent, RESEND_API_KEY unset) to=${to} subject=${subject}\n${text}`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.mail.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.mail.from, to, subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export const sendLoginLink = ({ email, url }) =>
  send({
    to: email,
    subject: 'Your pwamart sign-in link',
    text: `Tap to sign in to pwamart:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
  });

const day = (d) => new Date(d).toISOString().slice(0, 10);

export const sendRenewalReminder = ({ email, plan, periodEnd, kind, url }) =>
  send({
    to: email,
    subject: kind === 'ended' ? `Your pwamart ${plan} plan has ended` : `Your pwamart ${plan} plan ends ${day(periodEnd)}`,
    text:
      (kind === 'ended'
        ? `Your ${plan} plan ended on ${day(periodEnd)}. Your listings stay live; adding publishers or apps past the Free limits needs a plan again.`
        : `Your ${plan} plan is paid through ${day(periodEnd)}. Payment is prepaid crypto, so nothing renews on its own.`) +
      `\n\nRenew, switch plans or cancel these reminders here:\n\n${url}\n`,
  });

export const sendClaimVerified = async ({ email, publisher, apps, url }) =>
  send({
    to: email,
    subject: `${publisher} is yours on pwamart`,
    text: await withPromo(email, `Your proof of the domain checked out, so ${publisher} and its ${apps} app${apps === 1 ? '' : 's'} on pwamart now belong to your account.\n\nManage them here:\n\n${url}`),
  });

export const sendOrgInvite =({ email, orgName, url }) =>
  send({
    to: email,
    subject: `You were added to ${orgName} on pwamart`,
    text: `${orgName} added you on pwamart, where they publish their web apps.\n\nSign in with this email address to join:\n\n${url}`,
  });

/* ----------------------------------------------- listing emails + network -- */

// CoinPay-only accounts carry a placeholder address nobody reads.
const deliverable = (email) => Boolean(email) && !/@coinpay\./i.test(email);

/**
 * Append the network block (@profullstack/cross-promo): the other directories and
 * maker tools from the live catalog, never pwamart itself. Never throws.
 */
export async function withPromo(email, text) {
  const promo = await promoBlock({ site: 'pwamart.com', audience: 'makers', seed: email });
  return promo.text ? `${text}\n\n${promo.text}` : text;
}

/** Sent when an app is submitted. Unverified apps get the one step left before they can publish. */
export async function appSubmittedMail({ email, name, slug, verified, verify }) {
  const manage = `${config.siteUrl}/console/apps/${slug}`;
  const steps = verified
    ? `It is already verified, so it can go live now: open it and press Publish.\n\n${manage}`
    : `One step before it can go live: prove you own the origin, then press Publish. Any one of these works:\n\n` +
      (verify?.options ?? []).map((o) => `- ${o.how}`).join('\n') +
      `\n\nThen check and publish here:\n\n${manage}`;
  return {
    to: email,
    subject: verified ? `${name} is ready to publish on pwamart` : `We got ${name}: one step to go live on pwamart`,
    text: await withPromo(email, `Thanks for submitting ${name} to pwamart, the app store for web apps.\n\n${steps}`),
  };
}

/** Sent the first time an app is published. */
export async function appPublishedMail({ email, name, slug }) {
  const page = `${config.siteUrl}/apps/${slug}`;
  return {
    to: email,
    subject: `${name} is live on pwamart`,
    text: await withPromo(
      email,
      `${name} is live on pwamart:\n\n${page}\n\nShare that link: installs, votes and reviews move it up the charts. Keep the footer badge on your site and it stays verified:\n\n${config.siteUrl}/for?site=${encodeURIComponent(page)}`,
    ),
  };
}

export const sendAppSubmitted = async (args) => (deliverable(args.email) ? send(await appSubmittedMail(args)) : false);
export const sendAppPublished = async (args) => (deliverable(args.email) ? send(await appPublishedMail(args)) : false);
