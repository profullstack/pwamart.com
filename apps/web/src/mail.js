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
    subject: 'Your tleehealth sign-in link',
    text: `Tap to sign in to tleehealth:\n\n${url}\n\nThe link works once and expires in 20 minutes.\nIf you did not ask for it, ignore this email.`,
  });

export const sendAddedToOrg = ({ email, orgName, userType, url }) =>
  send({
    to: email,
    subject: `${orgName} added you on tleehealth`,
    text:
      userType === 'patient'
        ? `${orgName} uses tleehealth for appointments, results and prescriptions.\n\nSign in with this email address to see your visits and records:\n\n${url}`
        : `${orgName} added you to their team on tleehealth as ${userType.replace('_', ' ')}.\n\nSign in with this email address to get started:\n\n${url}`,
  });
