import { config } from './config.js';
import { e, layout } from './pages.js';

/**
 * /privacy and /terms. Privacy says only what the code collects: keep it in step
 * with auth, billing, follows/newsletter, community, the profile helper and MCP.
 * No ad slot on either page.
 */

export const LEGAL_EFFECTIVE = 'November 11, 2026';
const CONTACT = 'support@profullstack.com';
const OPERATOR = 'Profullstack, Inc., 16375 Bonnie Lane, Los Gatos, CA 95032, USA';

const section = (title, html) => `<h2>${e(title)}</h2>\n${html}`;

function legalBody(heading, intro, sections) {
  return `<div class="wrap">
  <article class="block legal" style="padding-top:48px;max-width:760px">
    <h1>${e(heading)}</h1>
    <p class="muted">Effective date: ${e(LEGAL_EFFECTIVE)}</p>
    ${intro}
    ${sections.join('\n')}
  </article>
</div>`;
}

export function privacyPage() {
  const mcp = `${config.siteUrl}/mcp`;
  const body = legalBody(
    'Privacy Policy',
    `<p>pwamart (pwamart.com) is operated by ${e(OPERATOR)}. This policy covers the website, the publisher console, the API, the CLI and TUI, and the MCP server. Browsing and installing apps needs no account.</p>`,
    [
      section(
        'Accounts',
        `<p><strong>Email sign-in.</strong> Your email address is your account. Each sign-in link is stored as a hash with its expiry. There are no passwords.</p>
<p><strong>Passkeys.</strong> If you register one: its credential id, public key, signature counter and transports. The private key never leaves your device.</p>
<p><strong>Sign in with CoinPay.</strong> If you use it: your CoinPay account identifier (DID). Accounts are matched by that identifier, never by email.</p>
<p><strong>Signup profile.</strong> The fields you fill in: first and last name, company domain, job title and LinkedIn URL.</p>
<p><strong>Sessions.</strong> A session id held in a cookie, stored with the browser user agent and an expiry.</p>
<p><strong>API keys and CLI sign-in.</strong> API keys are stored as a hash with a short display prefix. Signing in the CLI or another client through pwamart's OAuth stores only hashes of the codes and tokens, with their scope and expiry.</p>`,
      ),
      section(
        'What publishers store',
        `<p>Organizations and their members, publishers (name, website, logo, bio), apps and their manifests, releases, and the domain-verification records you add. "Fill from website" reads your publisher's public website; when the site has no description of its own, that page text is sent to an AI model (c0mpute, or Anthropic as a fallback) to draft a short bio, which you can edit before saving.</p>`,
      ),
      section(
        'Community',
        `<p>Upvotes, reviews, ratings, comments and tracked shares, the karma they earn, credit codes you redeem and invites you send or accept. Reviews, comments and your display name and karma are public.</p>`,
      ),
      section(
        'Following and the newsletter',
        `<p>You can follow an app or publisher by account, by email (double opt-in) or by browser push, and subscribe to the newsletter by email (double opt-in). We store the address or push subscription, what it follows, and a record of each delivery so nothing is sent twice. Push messages are delivered by your browser vendor's push service.</p>`,
      ),
      section(
        'Payments',
        `<p>Plans and featured placements are paid through CoinPay's hosted checkout (major coins, or PayPal through CoinPay). We store the payment reference, amount, currency, status and the payment record CoinPay sends us, and the plan periods it pays for. We never see your card, PayPal or wallet details.</p>`,
      ),
      section(
        'Installs',
        `<p>Each install is counted with its method (web, iOS, Android, desktop, CLI, TUI, MCP and so on), and with your account if you are signed in.</p>`,
      ),
      section(
        'Cookies, analytics and scripts',
        `<p>We use a session cookie for sign-in, a short-lived cookie during Sign in with CoinPay, and a cookie that remembers an invite link you opened. We do not use advertising cookies.</p>
<p>Pages load CrawlProof (crawlproof.com) analytics, and some catalogue pages show one CrawlProof text-link ad in a frame served by crawlproof.com. The WebMCP script, which lets an AI agent in your browser use this site, is served by jsDelivr. These receive your IP address and browser details when your browser loads them.</p>`,
      ),
      section(
        'Who else is involved',
        `<ul>
<li>Resend: delivers sign-in links, confirmations, release notices and the newsletter.</li>
<li>CoinPay (coinpayportal.com): payments and Sign in with CoinPay.</li>
<li>CrawlProof: analytics, the ad frame, and the ad campaigns that promote listed and featured apps.</li>
<li>c0mpute and Anthropic: draft publisher bios from public website text, as described above.</li>
<li>saasrow.com: a source of public PWA listings that we import; nothing about you is sent there.</li>
</ul>
<p>We do not sell your personal information.</p>`,
      ),
      section(
        'AI agents and MCP',
        `<p>The MCP server is at <code>${e(mcp)}</code>. Without a credential, an MCP client can read public data: search and read apps, collections and categories, install instructions, badges, releases, comments and the karma leaderboard, and subscribe an email address to the newsletter (which only sends a confirmation). Publishing and account actions (submitting, verifying, publishing and featuring apps, filling and verifying publishers, following, voting, reviewing, commenting, credit codes, invites and your karma) need a pwamart API key or an OAuth access token from <code>pwamart login</code>, sent as a bearer token, and act only on that account.</p>
<p>MCP and API requests are logged (time, tool or route, IP address, and the account or key if any) for abuse prevention and rate limiting. No MCP data is sold or used for advertising.</p>`,
      ),
      section(
        'Security',
        `<p>Data travels over TLS. Sign-in links, API keys and OAuth tokens are stored only as hashes. No system is perfectly secure, and we cannot guarantee absolute security.</p>`,
      ),
      section(
        'Your rights',
        `<p>Depending on where you live, you may have the right to access, correct, delete or export your personal data. Email us from the address on your account to ask.</p>`,
      ),
      section('Children', `<p>pwamart is not directed at children under 13, and we do not knowingly collect personal information from them.</p>`),
      section('Changes', `<p>If what we collect changes, this page changes with it, and the effective date above is updated.</p>`),
      section('Contact', `<p>Privacy questions: <a href="mailto:${CONTACT}">${CONTACT}</a>. ${e(OPERATOR)}.</p>`),
    ],
  );
  return layout({ title: 'Privacy Policy', description: 'What pwamart collects, why, who else is involved, and how the MCP server and API handle your data.', path: '/privacy', body });
}

export function termsPage() {
  const body = legalBody('Terms of Service', '', [
    section(
      '1. Acceptance of Terms',
      `<p>By accessing or using pwamart (the "Service"), including the website, console, API, CLI, TUI and MCP server, you agree to these Terms of Service. If you do not agree, do not use the Service. The Service is operated by Profullstack, Inc.</p>`,
    ),
    section(
      '2. Use of the Service',
      `<p>pwamart is a store for Progressive Web Apps: it lists apps and helps you install them. Apps are made and run by their publishers, on their own domains, under their own terms. Please do not send automated traffic heavy enough to degrade the Service for anyone else; the API, the MCP server, the feeds and the sitemap are there so you do not have to scrape.</p>`,
    ),
    section(
      '3. Accounts',
      `<p>You are responsible for safeguarding your account, passkeys, API keys and tokens, and for all activity that occurs under your account. Notify us immediately of any unauthorized use.</p>`,
    ),
    section(
      '4. Publishers and Listings',
      `<p>List only apps you publish or are authorized to list, and keep their details accurate. Domain verification proves you run the site. We may decline, hide or remove listings, reviews and comments that are misleading, abusive or unlawful.</p>`,
    ),
    section(
      '5. Payments',
      `<p>Plans are prepaid by the year and featured placements are a one-time payment, in cryptocurrency or PayPal through CoinPay's hosted checkout. Nothing is charged automatically. Prices are shown on the pricing page.</p>`,
    ),
    section(
      '6. Your Content',
      `<p>You keep ownership of the listings, reviews and comments you post, and you grant us permission to host, display and distribute them through the Service, including the API, MCP server and feeds. Reviews and comments are public.</p>`,
    ),
    section(
      '7. MCP and API Use',
      `<p>The MCP server and API may be used by people and AI agents within the rate limits. Use keys and tokens only for your own account, and do not use them to post spam, inflate votes or karma, or get around limits. We may revoke keys and tokens that are abused.</p>`,
    ),
    section(
      '8. Intellectual Property',
      `<p>The pwamart name, design and code are the property of Profullstack, Inc. or its licensors. Listed apps, their names and icons belong to their publishers. Open-source components are governed by their respective licenses.</p>`,
    ),
    section(
      '9. Disclaimer of Warranties',
      `<p>The Service is provided "as is" without warranties of any kind. Listed apps are run by their publishers, and we do not guarantee their availability, content or behavior. We do not guarantee that the Service will be uninterrupted, secure, or error-free.</p>`,
    ),
    section(
      '10. Limitation of Liability',
      `<p>To the maximum extent permitted by law, Profullstack, Inc. shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of your use of the Service.</p>`,
    ),
    section('11. Changes to Terms', `<p>We may update these Terms from time to time. Continued use of the Service after changes constitutes acceptance of the revised Terms.</p>`),
    section('12. Contact', `<p>Questions about these Terms? Email <a href="mailto:${CONTACT}">${CONTACT}</a>. ${e(OPERATOR)}.</p>`),
  ]);
  return layout({ title: 'Terms of Service', description: 'The terms for using pwamart, its console, API, CLI and MCP server.', path: '/terms', body });
}
