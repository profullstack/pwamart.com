import { describe, expect, test } from 'bun:test';

process.env.CROSS_PROMO = 'bundled';
const { appSubmittedMail, appPublishedMail, sendAppSubmitted } = await import('../apps/web/src/mail.js');

describe('listing emails carry the network block', () => {
  test('submitted, unverified: verify steps, then sister directories, never pwamart itself', async () => {
    const m = await appSubmittedMail({
      email: 'maker@example.test',
      name: 'Notely',
      slug: 'notely',
      verified: false,
      verify: { options: [{ method: 'meta', how: 'Add <meta name="pwamart-verification" content="abc">' }] },
    });
    expect(m.subject).toBe('We got Notely: one step to go live on pwamart');
    expect(m.text).toContain('pwamart-verification');
    expect(m.text).toContain('/console/apps/notely');
    expect(m.text).toContain('built.indie.pit.world/submit');
    expect(m.text).toContain('saasrow.pwa.pit.world/submit');
    expect(m.text).toContain('utm_source=pwamart.com');
    expect(m.text).not.toContain('pwamart.com/console/submit');
    expect(m.text.indexOf('Then check and publish')).toBeLessThan(m.text.indexOf('List it free in more places'));
  });

  test('submitted, already verified', async () => {
    const m = await appSubmittedMail({ email: 'maker@example.test', name: 'Notely', slug: 'notely', verified: true, verify: {} });
    expect(m.subject).toBe('Notely is ready to publish on pwamart');
    expect(m.text).toContain('List it free in more places');
  });

  test('published', async () => {
    const m = await appPublishedMail({ email: 'maker@example.test', name: 'Notely', slug: 'notely' });
    expect(m.subject).toBe('Notely is live on pwamart');
    expect(m.text).toContain('/apps/notely');
    expect(m.text).toContain('built.indie');
  });

  test('CoinPay placeholder addresses get nothing', async () => {
    expect(await sendAppSubmitted({ email: 'didkeyz@coinpay.pwamart.com', name: 'X', slug: 'x', verified: true })).toBe(false);
  });
});
