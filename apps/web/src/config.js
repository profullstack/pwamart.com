/**
 * Settings, read from the environment on every access. The deploy writes the
 * environment from the vault (pwamart--prod); nothing here has a secret default.
 */
const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  get siteUrl() {
    return env('SITE_URL', 'http://localhost:3000').replace(/\/$/, '');
  },
  get isProd() {
    return env('NODE_ENV') === 'production';
  },
  /** Addresses that become staff on sign-in: they can verify publishers and feature apps. */
  get adminEmails() {
    return env('ADMIN_EMAILS', 'anthony@profullstack.com,ettinger@gmail.com')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  },
  session: { cookie: 'pm_session', ttlDays: 30 },
  // CrawlProof (Profullstack, Inc. org): traffic via stats.js, one text-link ad slot.
  // Both ids are public (they ship in the page); env overrides for another project.
  crawlproof: {
    get site() {
      return env('CRAWLPROOF_SITE', '64571694-195a-41ae-bce3-b415ec0afb76');
    },
    get slot() {
      return env('CRAWLPROOF_SLOT', '36088096-9570-4417-856c-721de727580c');
    },
    // Server side only: the free ad every featured app gets, and the /advertise numbers.
    get apiToken() {
      return env('CRAWLPROOF_API_TOKEN');
    },
    get apiUrl() {
      return env('CRAWLPROOF_API_URL', 'https://crawlproof.com').replace(/\/$/, '');
    },
  },
  mail: {
    get enabled() {
      return Boolean(process.env.RESEND_API_KEY);
    },
    get resendKey() {
      return env('RESEND_API_KEY');
    },
    get from() {
      return env('MAIL_FROM', 'pwamart <noreply@pwamart.com>');
    },
  },
  // Passed WHOLE to the shared payments module: its getters read the environment
  // on every access, which that module depends on.
  coinpay: {
    get enabled() {
      return Boolean(process.env.COINPAY_API_KEY && process.env.COINPAY_BUSINESS_ID);
    },
    get baseUrl() {
      return env('COINPAY_API_URL', 'https://coinpayportal.com').replace(/\/$/, '');
    },
    get apiKey() {
      return env('COINPAY_API_KEY');
    },
    get businessId() {
      return env('COINPAY_BUSINESS_ID');
    },
    get webhookSecret() {
      return env('COINPAY_WEBHOOK_SECRET');
    },
    get defaultChain() {
      return env('COINPAY_DEFAULT_CHAIN', 'USDC_POL');
    },
  },
};

/**
 * Plans belong to the account. Limits count publishers and apps across every org
 * the account owns. `null` means no limit. Only unlimited can share an org with
 * other people, make teams, or group apps into projects.
 */
export const PLANS = {
  free: { name: 'Free', priceCents: 0, publishers: 1, apps: 10, teams: false },
  pro: { name: 'Pro', priceCents: 1000, publishers: 10, apps: 100, teams: false },
  unlimited: { name: 'Unlimited', priceCents: 19900, publishers: null, apps: null, teams: true },
};

export const CATEGORIES = [
  ['productivity', 'Productivity'],
  ['developer-tools', 'Developer tools'],
  ['ai', 'AI & agents'],
  ['communication', 'Communication'],
  ['social', 'Social'],
  ['media', 'Music & video'],
  ['news', 'News & reading'],
  ['finance', 'Finance & crypto'],
  ['business', 'Business'],
  ['education', 'Education'],
  ['health', 'Health & fitness'],
  ['lifestyle', 'Lifestyle'],
  ['shopping', 'Shopping'],
  ['travel', 'Travel & maps'],
  ['games', 'Games'],
  ['utilities', 'Utilities'],
  ['security', 'Security & privacy'],
  ['design', 'Design & photo'],
];
export const CATEGORY_NAMES = Object.fromEntries(CATEGORIES);
