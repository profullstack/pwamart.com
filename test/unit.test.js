import { describe, expect, test } from 'bun:test';
import { listingName, manifestToken, pickIcon, readHead } from '../apps/web/src/inspect.js';
import { sharedHost } from '../apps/web/src/shared-hosts.js';
import { aiBio, pageText, pickLogo } from '../apps/web/src/profile.js';
import { PUBLISHER_POSTS, publisherPosts } from '../apps/web/src/share-posts.js';
import { summarizeNetwork } from '../apps/web/src/crawlproof.js';
import { advertisePage, compact, e, reachTiles, safeUrl } from '../apps/web/src/pages.js';
import { TOOLS, installInstructions } from '../packages/mcp/src/core.js';
import { formatList, parse } from '../packages/cli/src/cli.js';
import { appArgs, desktopEntry, findBrowser } from '../packages/cli/src/install.js';
import { initialState, renderStore } from '../packages/cli/src/tui.js';

describe('inspector parsing', () => {
  test('readHead finds the manifest, theme color, verification meta and service worker', () => {
    const h = readHead(
      `<head><link href="/m.json" rel="manifest"><meta content="#fff" name="theme-color"><meta name='pwamart-verification' content='abc'>
       <title>X &amp; Y</title><script>navigator.serviceWorker.register("/sw.js")</script>`,
      new URL('https://a.example/app/'),
    );
    expect(h.manifest).toBe('https://a.example/m.json');
    expect(h.themeColor).toBe('#fff');
    expect(h.verify).toBe('abc');
    expect(h.title).toBe('X & Y');
    expect(h.registersServiceWorker).toBe(true);
  });

  test('a manifest carries its verification token under "pwamart"', () => {
    expect(manifestToken({ name: 'x', pwamart: { verification: ' tok ' } })).toBe('tok');
    expect(manifestToken({ pwamart: { verification: 42 } })).toBe(null);
    expect(manifestToken(null)).toBe(null);
  });

  test('shared hosts are told apart from domains of their own', () => {
    expect(sharedHost('me.vercel.app')).toBe('vercel.app');
    expect(sharedHost('Docs.User.GitHub.io.')).toBe('github.io');
    expect(sharedHost('github.io')).toBe('github.io');
    expect(sharedHost('notvercel.app')).toBe(null);
    expect(sharedHost('pwamart.com')).toBe(null);
  });

  test('a publisher logo prefers the manifest icon, then apple-touch, then a favicon, then og:image', () => {
    const head = { appleIcon: 'https://a.example/apple.png', icons: ['https://a.example/favicon.ico', 'https://a.example/icon.svg'], ogImage: 'https://a.example/og.jpg' };
    expect(pickLogo({ manifest: { icons: [{ src: 'https://a.example/512.png', sizes: '512x512' }] }, head })).toEqual({ src: 'https://a.example/512.png', from: 'manifest' });
    expect(pickLogo({ manifest: null, head }).from).toBe('apple-touch-icon');
    expect(pickLogo({ manifest: null, head: { ...head, appleIcon: null } })).toEqual({ src: 'https://a.example/icon.svg', from: 'favicon' });
    expect(pickLogo({ manifest: null, head: { icons: [], ogImage: 'https://a.example/og.jpg' } }).from).toBe('og:image');
    expect(pickLogo({ manifest: null, head: { icons: [] } })).toBe(null);
  });

  test('page text for a bio drops scripts and tags; no key means no AI bio', async () => {
    expect(pageText('<style>x{}</style><h1>Acme</h1><script>evil()</script><p>We make&nbsp;tools &amp; more.</p>')).toBe('Acme We make tools & more.');
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(await aiBio({ name: 'Acme', url: 'https://a.example', text: 'Acme makes tools.' })).toBe(null);
    if (key) process.env.ANTHROPIC_API_KEY = key;
  });

  test('publisher share posts: about 50, all filled, URL last, no em dashes', () => {
    const url = 'https://pwamart.com/publishers/acme';
    const withBio = publisherPosts({ name: 'Acme', bio: 'Acme makes tools for writers.', apps: 7, url });
    expect(withBio.length).toBe(PUBLISHER_POSTS.length);
    expect(withBio.length).toBeGreaterThanOrEqual(45);
    expect(new Set(withBio).size).toBe(withBio.length);
    for (const p of withBio) {
      expect(p).not.toMatch(/\{\w+\}/);
      expect(p.endsWith(url)).toBe(true);
      expect(p).not.toContain('—');
    }
    const bare = publisherPosts({ name: 'Acme', bio: null, apps: 1, url });
    expect(bare.length).toBeLessThan(withBio.length);
    expect(bare.some((p) => p.includes('reasons'))).toBe(false);
    expect(bare.some((p) => p.includes('1 apps'))).toBe(false);
  });

  test('listingName trims page-title style names', () => {
    expect(listingName('HQTUI — High Quality Terminal UI for TypeScript', 'HQTUI')).toBe('HQTUI');
    expect(listingName('QryptChat - Quantum-Resistant Messaging')).toBe('QryptChat');
    expect(listingName('bl0ggers. — Human-in-the-loop AI publishing')).toBe('bl0ggers.');
    expect(listingName('Quantum-Resistant')).toBe('Quantum-Resistant');
    expect(listingName('A very long application name without separators', 'Short')).toBe('Short');
    expect(listingName('notes app', 'notes')).toBe('notes app');
  });

  test('pickIcon prefers the largest "any" icon over maskable', () => {
    const icons = [
      { src: 'a', sizes: '192x192' },
      { src: 'b', sizes: '512x512', purpose: 'maskable' },
      { src: 'c', sizes: '512x512' },
    ];
    expect(pickIcon(icons, 512).src).toBe('c');
  });
});

describe('pages', () => {
  test('escape and URL guards', () => {
    expect(e(`<a href="x">'`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('https://ok.example/x')).toBe('https://ok.example/x');
  });
});

describe('network stats', () => {
  const earnings = {
    rangeDays: 30,
    totals: { pubImpressions: 702075, pubPaidImpressions: 0, pubFreeImpressions: 702075, pubClicks: 29956, pubBilledClicks: 0, pubFreeClicks: 29956, invalidClicks: 151762 },
  };
  const slots = [
    { status: 'active', site: 'a.example' },
    { status: 'active', site: 'a.example' },
    { status: 'active', site: 'b.example' },
    { status: 'inactive', site: 'c.example' },
  ];

  test('totals add the paid and free halves and leave refused clicks out', () => {
    const n = summarizeNetwork({ earnings, slots, traffic: [{ site: 'a.example', visitors: 10, pageviews: 30 }, { site: 'b.example', visitors: 90, pageviews: 100 }, null] });
    expect(n.impressions).toBe(702075);
    expect(n.clicks).toBe(29956);
    expect(n.ctr).toBeCloseTo(0.0427, 3);
    expect(n.slots).toBe(3);
    expect(n.sites).toBe(2);
    expect(n.visitors).toBe(100);
    expect(n.pageviews).toBe(130);
    expect(n.measuredSites).toBe(2);
    expect(n.properties[0].site).toBe('b.example');
  });

  test('no traffic reports means unknown visitors, not zero', () => {
    expect(summarizeNetwork({ earnings, slots }).visitors).toBe(null);
  });

  test('the reach tiles stay out until there are numbers, then show them', () => {
    expect(reachTiles(null)).toBe('');
    expect(reachTiles(summarizeNetwork({ earnings: { totals: {} }, slots: [] }))).toBe('');
    const html = reachTiles(summarizeNetwork({ earnings, slots, traffic: [{ site: 'a.example', visitors: 8525, pageviews: 10697 }] }));
    expect(html).toContain('702K');
    expect(html).toContain('30K');
    expect(html).toContain('4.3%');
    expect(html).toContain('/advertise');
    expect(compact(1_234_567)).toBe('1.2M');
  });

  test('the advertise page sells the free ad and renders without network numbers', () => {
    const page = advertisePage({ stats: { apps: 50, publishers: 3, installs: 0 }, net: null });
    expect(page).toContain('A free campaign');
    expect(page).toContain('appear here once they have loaded');
    const full = advertisePage({
      stats: { apps: 50, publishers: 3, installs: 0 },
      net: { ...summarizeNetwork({ earnings, slots, traffic: [{ site: 'a.example', visitors: 8525, pageviews: 10697 }] }), updatedAt: '2026-10-06T12:00:00Z' },
    });
    expect(full).toContain('8.5K people a month');
    expect(full).toContain('a.example');
    expect(full).toContain('2026-10-06 12:00 UTC');
  });
});

describe('cli', () => {
  test('parse handles flags, --no- and inline values', () => {
    expect(parse(['install', 'notes', '--no-launch', '--server=http://x', '--category', 'ai'])).toEqual({
      positional: ['install', 'notes'],
      flags: { launch: false, server: 'http://x', category: 'ai' },
    });
  });

  test('formatList', () => {
    const out = formatList({ total: 1, apps: [{ slug: 'notes', name: 'Notes', rating: 4.5, installs: 12, publisher: { name: 'Alice' } }] });
    expect(out).toContain('notes');
    expect(out).toContain('★ 4.5');
    expect(out).toContain('1 app');
  });

  test('desktop entries quote everything and cannot inject lines', () => {
    const entry = desktopEntry({ name: 'Evil\nExec=rm -rf ~', slug: 'evil', url: 'https://e.example/?a=$(id)', bin: '/usr/bin/tron', summary: 'x' });
    expect(entry.split('\n').filter((l) => l.startsWith('Exec=')).length).toBe(1);
    expect(entry).toContain('\\$(id)');
    expect(appArgs('https://x', 'x')).toEqual(['--app=https://x', '--class=pwamart-x']);
  });

  test('PWAMART_BROWSER overrides discovery', () => {
    expect(findBrowser({ PWAMART_BROWSER: '/opt/tron' })).toEqual({ name: '/opt/tron', bin: '/opt/tron', tron: true });
  });
});

describe('mcp', () => {
  test('tools are well formed', () => {
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.inputSchema.type).toBe('object');
    }
  });
  test('install instructions per platform', () => {
    const app = { slug: 'notes', name: 'Notes', start_url: 'https://n.example/', profile_url: 'https://pwamart.com/apps/notes/install.mobileconfig' };
    expect(installInstructions(app, 'tron').command).toBe('tron --app=https://n.example/');
    expect(installInstructions(app, 'linux').command).toBe('npx -y @profullstack/pwamart install notes');
    expect(installInstructions(app, 'ios').steps[1]).toContain('mobileconfig');
  });
});

describe('payments', () => {
  // Stripe is off-limits (house rule): CoinPay's 'card' and 'both' methods open a Stripe session.
  test('checkout is crypto only', async () => {
    const src = await Bun.file(new URL('../apps/web/src/api.js', import.meta.url)).text();
    expect(src).toContain("paymentMethod: 'crypto'");
    expect(src).not.toMatch(/paymentMethod:\s*'(card|both)'/);
  });
});

describe('tui', () => {
  test('renders the store view', async () => {
    const state = initialState();
    state.list = { total: 1, apps: [{ slug: 'notes', name: 'Notes', rating: 4, category_name: 'Productivity', publisher: { name: 'Alice' } }] };
    state.detail = {
      app: {
        slug: 'notes', name: 'Notes', summary: 'Write things', description: 'A notes app.', start_url: 'https://n.example/', rating: 4,
        rating_count: 3, installs: 9, score: 90, verified: true, category_name: 'Productivity', publisher: { name: 'Alice', verified: true },
        checks: [{ level: 'required', ok: true, label: 'Links a web app manifest' }],
      },
    };
    const text = await renderStore(state);
    expect(text).toContain('pwamart');
    expect(text).toContain('Notes');
    expect(text).toContain('pwamart install notes');
  });
});
