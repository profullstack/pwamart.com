import { CATEGORIES, CATEGORY_NAMES, PLANS, config } from './config.js';

/**
 * Server-rendered store pages. Plain template strings: every value from the
 * database goes through `e()`, every URL through `safeUrl()`, nothing else is
 * trusted. The pages work with JavaScript off; store.js only adds the Install
 * sheet and search-as-you-type.
 */

export const e = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const safeUrl = (u) => {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : '';
  } catch {
    return '';
  }
};

const MARK = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#16211d"/><ellipse cx="32" cy="32" rx="27" ry="10.5" transform="rotate(-28 32 32)" fill="none" stroke="#f6f4ed" stroke-opacity=".28" stroke-width="1.6"/><rect x="16" y="16" width="14" height="14" rx="4" fill="#f6f4ed"/><rect x="16" y="34" width="14" height="14" rx="4" fill="#f6f4ed"/><rect x="34" y="34" width="14" height="14" rx="4" fill="#f6f4ed"/><rect x="34" y="16" width="14" height="14" rx="7" fill="#e2582f"/><path d="M41 19.5v7M37.5 23h7" stroke="#16211d" stroke-width="2.2" stroke-linecap="round"/><circle cx="55.2" cy="18.6" r="2.6" fill="#e2582f"/></svg>`;
const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
export const CHECK = `<svg class="verified" viewBox="0 0 24 24" fill="currentColor" aria-label="verified"><path d="M12 2l2.4 2.1 3.2-.4.9 3.1 2.8 1.6-1 3 1 3-2.8 1.6-.9 3.1-3.2-.4L12 22l-2.4-2.1-3.2.4-.9-3.1-2.8-1.6 1-3-1-3 2.8-1.6.9-3.1 3.2.4z"/><path d="m8.5 12.2 2.3 2.3 4.7-4.9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function layout({ title, description, path = '/', body, stats, head = '', noindex = false }) {
  const url = `${config.siteUrl}${path}`;
  const t = title ? `${title} · pwamart` : 'pwamart: the app store for web apps';
  const d = description ?? 'Find and install Progressive Web Apps on any phone, tablet or computer. No app store review, no 30% cut, nothing to root.';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${e(t)}</title>
<meta name="description" content="${e(d)}">
<link rel="canonical" href="${e(url)}">
<meta property="og:title" content="${e(t)}">
<meta property="og:description" content="${e(d)}">
<meta property="og:url" content="${e(url)}">
<meta property="og:image" content="${e(config.siteUrl)}/icon-512.png">
<meta name="twitter:card" content="summary">
${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta name="theme-color" content="#f6f4ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101814" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="pwamart">
<link rel="stylesheet" href="/assets/store.css">
<script data-site="${e(config.crawlproof.site)}" src="https://crawlproof.com/stats.js" async></script>
${head}
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/" aria-label="pwamart home">${MARK}<span>pwamart<b>.</b></span></a>
  <form class="search" action="/apps" role="search">${SEARCH_ICON}<input name="q" type="search" placeholder="Search web apps" aria-label="Search web apps" autocomplete="off"></form>
  <nav class="nav">
    <a href="/apps">Browse</a>
    <a href="/developers">Developers</a>
    <a href="/pricing">Pricing</a>
    <a class="keep" href="/console">Console</a>
    <a class="cta" href="/console/submit">Submit app</a>
  </nav>
</div></header>
${
  stats
    ? `<div class="hq"><div class="wrap">
  <span class="live">Store online</span>
  <span><b>${e(stats.apps)}</b> apps</span>
  <span><b>${e(stats.publishers)}</b> publishers</span>
  <span><b>${e(stats.installs)}</b> installs</span>
  <span>surfaces: web · pwa · cli · tui · mcp · api · desktop</span>
</div></div>`
    : ''
}
<main>${body}</main>
<footer class="foot"><div class="wrap">
  <div>
    <a class="brand" href="/" style="font-size:20px">${MARK.replace('<svg', '<svg style="width:26px;height:26px"')}<span>pwamart<b>.</b></span></a>
    <p style="max-width:340px">The app store for the open web. Built by <a href="https://profullstack.com">Profullstack</a>.</p>
  </div>
  <nav>
    <a href="/apps">Browse</a><a href="/developers">Developers</a><a href="/pricing">Pricing</a>
    <a href="/developers#api">API</a><a href="/developers#mcp">MCP</a><a href="/developers#cli">CLI &amp; TUI</a>
    <a href="/featured">Get featured</a><a href="/newsletter">Newsletter</a>
    <a href="/llms.txt">llms.txt</a><a href="https://github.com/profullstack/pwamart.com">GitHub</a>
  </nav>
</div></footer>
<script src="/assets/store.js" type="module"></script>
</body>
</html>`;
}

/**
 * One subtle CrawlProof text-link ad. The frame endpoint, not ad.js: it is a
 * cross-origin document with its own CSP, so ours only needs frame-src, and the
 * creative follows the reader's light/dark preference itself (no theme param).
 * text_link is the one fluid format (40px, carries its own "Sponsored" mark).
 */
/**
 * The share + badge builder on an app page: the store-button badge (dark/light),
 * copyable Markdown / HTML / text / link snippets, and a ready post with share
 * links per network. Everything is server-rendered and works without JS; store.js
 * adds Copy buttons, the theme toggle and live-editing of the post.
 */
export function shareBuilder(app) {
  const site = config.siteUrl;
  const page = `${site}/apps/${app.slug}`;
  const alt = `Get ${app.name} on pwamart`;
  const snippets = (theme) => {
    const src = `${site}/badges/get-it-on-pwamart${theme === 'light' ? '-light' : ''}.svg`;
    return {
      markdown: `[![${alt}](${src})](${page})`,
      html: `<a href="${page}"><img src="${src}" alt="${alt}" width="135" height="40"></a>`,
      text: `Get ${app.name} on pwamart: ${page}`,
      link: page,
    };
  };
  const dark = snippets('dark');
  const light = snippets('light');
  const post = `${app.name}${app.summary ? `: ${app.summary}` : ''}\n\nInstall it on any device, no app store needed:\n${page}`;
  const enc = encodeURIComponent;
  const nets = [
    ['x', 'X', `https://x.com/intent/post?text=${enc(post)}`],
    ['bluesky', 'Bluesky', `https://bsky.app/intent/compose?text=${enc(post)}`],
    ['linkedin', 'LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${enc(page)}`],
    ['reddit', 'Reddit', `https://www.reddit.com/submit?url=${enc(page)}&title=${enc(`${app.name}: install it on any device`)}`],
    ['hn', 'Hacker News', `https://news.ycombinator.com/submitlink?u=${enc(page)}&t=${enc(app.name)}`],
    ['facebook', 'Facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(page)}`],
    ['email', 'Email', `mailto:?subject=${enc(app.name)}&body=${enc(post)}`],
  ];
  const block = (kind, label, val) => `
      <div class="snip" data-kind="${kind}">
        <div class="snip-head"><span>${label}</span><button class="btn sm" type="button" data-copy>Copy</button></div>
        <pre><code data-dark="${e(dark[kind])}" data-light="${e(light[kind])}">${e(val)}</code></pre>
      </div>`;
  return `<section class="share" id="share">
    <h2 style="margin:36px 0 6px">Share this app</h2>
    <p class="muted" style="margin:0 0 16px">Put the badge in your README, site or socials. It links straight to this page.</p>
    <div class="share-grid">
      <div class="panel">
        <div class="badge-row">
          <a href="${e(page)}" class="badge-preview" data-badge><img src="/badges/get-it-on-pwamart.svg" alt="${e(alt)}" width="135" height="40" data-dark="/badges/get-it-on-pwamart.svg" data-light="/badges/get-it-on-pwamart-light.svg"></a>
          <div class="seg" role="radiogroup" aria-label="Badge style">
            <button type="button" class="on" data-theme="dark" aria-pressed="true">Dark</button>
            <button type="button" data-theme="light" aria-pressed="false">Light</button>
          </div>
        </div>
        ${block('markdown', 'Markdown (GitHub README)', dark.markdown)}
        ${block('html', 'HTML', dark.html)}
        ${block('text', 'Text', dark.text)}
        ${block('link', 'Link', dark.link)}
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">PNG: <a href="/badges/get-it-on-pwamart.png">1x</a> · <a href="/badges/get-it-on-pwamart@2x.png">2x</a> · <a href="/badges/get-it-on-pwamart@3x.png">3x</a> · light <a href="/badges/get-it-on-pwamart-light@2x.png">2x</a></p>
      </div>
      <div class="panel">
        <label class="post-label" for="share-post">Post</label>
        <textarea id="share-post" rows="6" data-page="${e(page)}" data-title="${e(app.name)}">${e(post)}</textarea>
        <div class="share-nets">
          <button class="btn sm dark" type="button" data-copy-post>Copy post</button>
          <button class="btn sm" type="button" data-native-share hidden>Share…</button>
          ${nets.map(([k, n, href]) => `<a class="btn sm" data-net="${k}" href="${e(href)}" target="_blank" rel="noopener">${n}</a>`).join('')}
        </div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">Mastodon, Threads, Discord or anywhere else: Copy post and paste.</p>
      </div>
    </div>
  </section>`;
}

/** An imported listing nobody has claimed yet: who can claim it, and how. */
export function claimNote(publisher) {
  return `<div class="claim-note"><span class="pill-unclaimed">Unclaimed</span>
    Imported from a public directory. Do you run <b>${e(publisher.claim_domain)}</b>?
    <a href="/console/claim/${e(publisher.slug)}">Claim it with a DNS record →</a></div>`;
}

export function adSlot(placement) {
  const src = `https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(config.crawlproof.slot)}&format=text_link`;
  return `<div class="cp-ad cp-ad-${e(placement)}"><iframe src="${e(src)}" title="Sponsored" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" scrolling="no"></iframe></div>`;
}

export function icon(app, cls = 'icon', size = 58) {
  const src = safeUrl(app.icon);
  if (src)
    return `<img class="${cls}" src="${e(src)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" style="background:${e(app.background_color || 'var(--paper-2)')}">`;
  return `<span class="${cls} ph" style="width:${size}px;height:${size}px">${e((app.name || '?').slice(0, 1).toUpperCase())}</span>`;
}

const stars = (r) => (r ? `★ ${Number(r).toFixed(1)}` : 'new');
const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n ?? 0));

export function card(app) {
  return `<a class="card" href="/apps/${e(app.slug)}">
  ${icon(app)}
  <div class="body">
    <div class="name">${e(app.name)}</div>
    <div class="by">${e(app.publisher.name)} ${app.publisher.verified ? CHECK : ''}</div>
    <div class="sum">${e(app.summary ?? '')}</div>
    <div class="meta"><span>${stars(app.rating)}</span><span>${fmt(app.installs)} installs</span><span>${e(app.category_name)}</span></div>
  </div>
</a>`;
}

export function grid(apps, emptyText = 'No apps here yet.') {
  if (!apps.length) return `<div class="empty">${e(emptyText)} <a href="/console/submit">Submit one</a>.</div>`;
  return `<div class="grid">${apps.map(card).join('')}</div>`;
}

function categoryChips(counts, active) {
  return `<div class="chips">
  <a class="chip${active ? '' : ' on'}" href="/apps">All</a>
  ${CATEGORIES.filter(([slug]) => counts[slug] || slug === active)
    .map(([slug, name]) => `<a class="chip${slug === active ? ' on' : ''}" href="/apps?category=${slug}">${e(name)} <small>${counts[slug] ?? 0}</small></a>`)
    .join('')}
</div>`;
}

/* --------------------------------------------------------------- home -- */

export function homePage({ featured, top, fresh, counts, stats }) {
  const tints = ['#e5eadb', '#f3e2d6', '#e1e6ee', '#efe6cf'];
  const body = `
<div class="wrap">
  <section class="hero">
    <div>
      <div class="eyebrow">The app store for the open web</div>
      <h1>Every web app, <em>installable</em> anywhere.</h1>
      <p class="lede">pwamart lists Progressive Web Apps and installs them on iPhone, Android, Mac, Windows and Linux, from a browser, a terminal, a desktop app or an AI agent. No app store review, no 30% cut, no rooting.</p>
      <div class="hero-actions">
        <a class="btn primary lg" href="/apps">Browse apps</a>
        <a class="btn lg" href="/console/submit">List your PWA free</a>
      </div>
    </div>
    <div class="term" aria-label="pwamart from a terminal">
      <div class="dots"><i></i><i></i><i></i></div>
      <div><span class="p">$</span> npx @profullstack/pwamart search notes</div>
      <div class="g">  ✓ ${e(stats.apps)} apps indexed</div>
      <div><span class="p">$</span> pwamart install <span class="o">${e(top[0]?.slug ?? 'your-app')}</span></div>
      <div class="g">  ✓ opened as an app window · desktop entry written</div>
      <div><span class="p">$</span> pwamart tui</div>
      <div class="p">  # browse the store in your terminal</div>
      <div><span class="p">$</span> claude mcp add pwamart -- npx -y @profullstack/pwamart-mcp</div>
    </div>
  </section>

  ${
    featured.length
      ? `<section class="block"><div class="block-head"><h2>Featured</h2><a href="/featured">Get featured · $19 →</a></div>
  <div class="feature-grid">${featured
    .slice(0, 4)
    .map(
      (a, i) => `<a class="feature" href="/apps/${e(a.slug)}" style="--tint:${tints[i % tints.length]}">
      ${icon(a, 'icon', 76)}
      <div><div class="eyebrow">${e(a.category_name)}</div><h3 style="margin:6px 0 4px">${e(a.name)}</h3><div class="muted" style="font-size:14px">${e(a.summary ?? '')}</div></div>
    </a>`,
    )
    .join('')}</div></section>`
      : ''
  }

  <section class="block"><div class="block-head"><h2>Categories</h2><a href="/apps">All apps →</a></div>${categoryChips(counts, null)}</section>
  <section class="block"><div class="block-head"><h2>Top apps</h2><a href="/apps?sort=top">See all →</a></div>${grid(top)}</section>
  ${adSlot('home')}
  <section class="block"><div class="block-head"><h2>New this week</h2><a href="/apps?sort=new">See all →</a></div>${grid(fresh)}</section>

  <section class="block">
    <div class="block-head"><h2>One store, every surface</h2></div>
    <div class="bigrow">
      <div class="tile"><div class="k">Phone</div><h3>One tap on Android</h3><p>Chrome installs a real app. On iPhone, Add to Home Screen or a one-tap profile.</p></div>
      <div class="tile"><div class="k">Desktop</div><h3>pwamart Desktop</h3><p>Install web apps as windows with their own icons on Mac, Windows and Linux.</p></div>
      <div class="tile"><div class="k">Terminal</div><h3>CLI + TUI</h3><p><code>pwamart</code> searches and installs; <code>pwamart tui</code> is the whole store on hqtui.</p></div>
      <div class="tile"><div class="k">Agents</div><h3>MCP + API</h3><p>Agents search the catalog and install apps through MCP or <code>/api/v1</code>.</p></div>
      <div class="tile"><div class="k">TronBrowser</div><h3>Built in</h3><p>Install opens the app in its own TronBrowser window with the launcher's settings.</p></div>
    </div>
  </section>
</div>`;
  return layout({ body, stats });
}

/* ------------------------------------------------------------- browse -- */

export function browsePage({ q, category, sort, list, counts, offset, limit, stats }) {
  const title = q ? `“${q}”` : category ? CATEGORY_NAMES[category] ?? 'Apps' : 'All web apps';
  const qs = (o) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (category) p.set('category', category);
    if (sort) p.set('sort', sort);
    if (o) p.set('offset', o);
    return `/apps?${p}`;
  };
  const sorts = [['top', 'Top'], ['new', 'Newest'], ['rating', 'Top rated'], ['name', 'A–Z']];
  const body = `<div class="wrap">
  <section class="block" style="padding-top:40px">
    <div class="eyebrow">${e(list.total)} result${list.total === 1 ? '' : 's'}</div>
    <h1 style="font-size:clamp(34px,5vw,56px);margin:8px 0 22px">${e(title)}</h1>
    ${categoryChips(counts, category)}
    ${q ? '' : `<div class="chips" style="margin-top:12px">${sorts.map(([k, n]) => `<a class="chip${(sort || 'top') === k ? ' on' : ''}" href="/apps?${new URLSearchParams({ ...(category ? { category } : {}), sort: k })}">${n}</a>`).join('')}</div>`}
  </section>
  <section class="block" style="padding-top:0">${grid(list.apps, q ? 'Nothing matches that search.' : 'No apps in this category yet.')}</section>
  ${list.apps.length ? adSlot('browse') : ''}
  <div class="pager">
    ${offset > 0 ? `<a class="btn" href="${e(qs(Math.max(0, offset - limit)))}">← Previous</a>` : ''}
    ${offset + limit < list.total ? `<a class="btn" href="${e(qs(offset + limit))}">Next →</a>` : ''}
  </div>
</div>`;
  return layout({ title, path: '/apps', body, stats, noindex: Boolean(q) });
}

/* ------------------------------------------------------------ details -- */

const SURFACE_ICONS = {
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
  desk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 9 3 3-3 3M12 15h5"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>',
};

export function appPage({ app, publisher, reviews, related, stats }) {
  const start = safeUrl(app.start_url) || safeUrl(app.url);
  const host = (() => {
    try {
      return new URL(app.origin).host;
    } catch {
      return app.origin;
    }
  })();
  const data = {
    slug: app.slug,
    name: app.name,
    start_url: start,
    manifest_id: app.manifest_id,
    icon: safeUrl(app.icon),
    installable: app.installable,
  };
  const required = (app.checks ?? []).filter((c) => c.level === 'required');
  const recommended = (app.checks ?? []).filter((c) => c.level !== 'required');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: app.name,
    url: start,
    applicationCategory: app.category_name,
    operatingSystem: 'Any (web browser)',
    description: app.summary ?? app.description ?? '',
    image: safeUrl(app.icon) || undefined,
    author: { '@type': 'Organization', name: publisher?.name ?? app.publisher.name },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    ...(app.rating_count ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: app.rating, ratingCount: app.rating_count } } : {}),
  };
  const body = `<div class="wrap">
  <section class="app-head">
    ${icon(app, 'icon', 128)}
    <div>
      <div class="eyebrow"><a href="/apps?category=${e(app.category)}" style="text-decoration:none">${e(app.category_name)}</a>${app.featured ? ' · <a href="/featured" style="text-decoration:none;color:#e2582f">★ Featured</a>' : ''}</div>
      <h1 style="margin-top:8px">${e(app.name)}</h1>
      <div class="by">by <a href="/publishers/${e(app.publisher.slug)}">${e(app.publisher.name)}</a> ${app.publisher.verified ? CHECK : ''} <span class="muted">· ${e(host)}</span></div>
      ${app.summary ? `<p class="lede" style="margin:12px 0 0;font-size:17px">${e(app.summary)}</p>` : ''}
      ${app.publisher.claimable ? claimNote(app.publisher) : ''}
      <div class="stats">
        <div><b>${app.rating ? `${Number(app.rating).toFixed(1)} ★` : '–'}</b><span>${e(app.rating_count)} ratings</span></div>
        <div><b>${fmt(app.installs)}</b><span>installs</span></div>
        <div><b>${app.score ?? '–'}${app.score !== null ? '%' : ''}</b><span>pwa score</span></div>
        <div><b>${app.verified ? 'Yes' : 'No'}</b><span>verified</span></div>
      </div>
    </div>
    <div class="install-box">
      <button class="btn primary lg" id="install" type="button" data-app='${e(JSON.stringify(data))}'>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>
        Install
      </button>
      <a class="btn" id="open" href="${e(start)}" target="_blank" rel="noopener">Open in browser</a>
      <div class="hint" id="install-hint">Free · works on phone, tablet and desktop</div>
    </div>
  </section>

  ${
    app.screenshots?.length
      ? `<div class="shots">${app.screenshots
          .map((s) => safeUrl(s.src))
          .filter(Boolean)
          .map((src) => `<img src="${e(src)}" alt="Screenshot of ${e(app.name)}" loading="lazy" referrerpolicy="no-referrer">`)
          .join('')}</div>`
      : ''
  }

  <div class="cols">
    <div>
      <h2 style="margin-bottom:12px">About</h2>
      <div class="prose">${e(app.description || app.summary || 'No description yet.')}</div>

      <h2 style="margin:36px 0 12px">Install it your way</h2>
      <div class="surfaces panel">
        <div class="surface"><span class="glyph">${SURFACE_ICONS.phone}</span><div><b>iPhone &amp; iPad</b> · Share → Add to Home Screen, or <a href="/apps/${e(app.slug)}/install.mobileconfig">the one-tap profile</a></div></div>
        <div class="surface"><span class="glyph">${SURFACE_ICONS.phone}</span><div><b>Android</b> · Install, then confirm in Chrome; it lands in your app drawer</div></div>
        <div class="surface"><span class="glyph">${SURFACE_ICONS.desk}</span><div><b>Desktop</b> · Chrome or Edge install it as a window; <a href="/developers#desktop">pwamart Desktop</a> does it for any browser</div></div>
        <div class="surface"><span class="glyph">${SURFACE_ICONS.term}</span><div><b>Terminal</b><code>npx -y @profullstack/pwamart install ${e(app.slug)}</code></div></div>
        <div class="surface"><span class="glyph">${SURFACE_ICONS.term}</span><div><b>TronBrowser</b><code>tron --app=${e(start)}</code></div></div>
        <div class="surface"><span class="glyph">${SURFACE_ICONS.bot}</span><div><b>Agents</b> · ask any MCP client to “install ${e(app.name)} from pwamart”</div></div>
      </div>

      ${shareBuilder(app)}

      <h2 style="margin:36px 0 4px">Ratings &amp; reviews</h2>
      ${reviews.length ? reviews.map((r) => `<div class="review"><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> <b>${e(r.author)}</b><div class="prose">${e(r.body)}</div></div>`).join('') : '<p class="muted">No reviews yet.</p>'}
      <form id="review" class="panel" style="margin-top:16px;display:grid;gap:10px" data-slug="${e(app.slug)}">
        <label>Your rating <select name="rating" required><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></label>
        <textarea name="body" rows="3" placeholder="What is it like to use? (sign in to post)" style="font:inherit;padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--paper);color:var(--ink)"></textarea>
        <button class="btn sm dark" style="justify-self:start">Post review</button>
      </form>
    </div>
    <aside style="display:grid;gap:14px;align-content:start">
      <div class="panel">
        <h3>Information</h3>
        <dl class="kv">
          <dt>Publisher</dt><dd><a href="/publishers/${e(app.publisher.slug)}">${e(app.publisher.name)}</a></dd>
          <dt>Website</dt><dd><a href="${e(safeUrl(app.origin))}" rel="noopener" target="_blank">${e(host)}</a></dd>
          <dt>Category</dt><dd>${e(app.category_name)}</dd>
          <dt>Opens as</dt><dd>${e(app.display ?? 'browser')}</dd>
          <dt>Price</dt><dd>Free to install</dd>
          ${app.updated_at ? `<dt>Checked</dt><dd>${e(new Date(app.checked_at ?? app.updated_at).toISOString().slice(0, 10))}</dd>` : ''}
          <dt>Manifest</dt><dd>${app.manifest_url ? `<a href="${e(safeUrl(app.manifest_url))}" rel="noopener nofollow" target="_blank">view</a>` : '–'}</dd>
        </dl>
      </div>
      <div class="panel">
        <h3>Installability</h3>
        <ul class="checks">
          ${required.map((c) => `<li><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✕'}</span>${e(c.label)}</li>`).join('')}
          ${recommended.map((c) => `<li><span class="${c.ok ? 'ok' : 'rec'}">${c.ok ? '✓' : '○'}</span>${e(c.label)}</li>`).join('')}
        </ul>
      </div>
      ${
        publisher
          ? `<div class="panel"><h3>${e(publisher.name)} ${publisher.verified ? CHECK : ''}</h3>${publisher.bio ? `<p class="muted" style="margin:0 0 8px;font-size:14px">${e(publisher.bio)}</p>` : ''}<a href="/publishers/${e(publisher.slug)}">More from this publisher →</a></div>`
          : ''
      }
      ${adSlot('app')}
    </aside>
  </div>
  ${related.length ? `<section class="block"><div class="block-head"><h2>More in ${e(app.category_name)}</h2></div>${grid(related)}</section>` : ''}
</div>
<dialog class="sheet" id="sheet"><div class="sheet-in" id="sheet-in"></div></dialog>`;
  return layout({
    title: `${app.name}: install the web app`,
    description: app.summary ?? `Install ${app.name} on any device from pwamart.`,
    path: `/apps/${app.slug}`,
    body,
    stats,
    noindex: app.status !== 'published',
    head: `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  });
}

/* ---------------------------------------------------------- publisher -- */

export function publisherPage({ publisher, list, stats }) {
  const body = `<div class="wrap">
  <section class="block" style="padding-top:44px">
    <div class="eyebrow">Publisher</div>
    <h1 style="font-size:clamp(34px,5vw,56px);margin:8px 0 10px">${e(publisher.name)} ${publisher.verified ? CHECK.replace('class="verified"', 'class="verified" style="width:28px;height:28px"') : ''}</h1>
    ${publisher.claimable ? claimNote(publisher) : publisher.bio ? `<p class="lede">${e(publisher.bio)}</p>` : ''}
    ${safeUrl(publisher.website) ? `<p><a href="${e(safeUrl(publisher.website))}" rel="noopener" target="_blank">${e(publisher.website)}</a></p>` : ''}
  </section>
  <section class="block" style="padding-top:0"><div class="block-head"><h2>${e(list.total)} app${list.total === 1 ? '' : 's'}</h2></div>${grid(list.apps, 'No published apps yet.')}</section>
</div>`;
  return layout({ title: publisher.name, path: `/publishers/${publisher.slug}`, body, stats });
}

/* ------------------------------------------------------------- pricing -- */

export function pricingPage({ stats }) {
  const p = PLANS;
  const body = `<div class="wrap">
  <section class="block" style="padding-top:48px;text-align:center">
    <div class="eyebrow">Pricing for publishers</div>
    <h1 style="margin:10px auto 14px;max-width:820px">Installing is always free. Listing starts free too.</h1>
    <p class="lede" style="margin:0 auto">Pay by the year in crypto through CoinPay. No cut of your sales, ever: your app takes its own payments.</p>
  </section>
  <div class="plans">
    <div class="plan">
      <div class="eyebrow">${p.free.name}</div>
      <div class="price">$0</div>
      <ul><li>1 publisher</li><li>Up to 10 apps</li><li>Details page with the Install button</li><li>CLI, TUI, MCP and API listing</li><li>Domain-verified badge</li></ul>
      <a class="btn" href="/console/submit">Start free</a>
    </div>
    <div class="plan hot">
      <div class="eyebrow">${p.pro.name}</div>
      <div class="price">$10<small> / year</small></div>
      <ul><li>Up to 10 publishers</li><li>Up to 100 apps</li><li>Everything in Free</li><li>Run several brands from one account</li></ul>
      <a class="btn primary" href="/console/billing?plan=pro">Get Pro</a>
    </div>
    <div class="plan">
      <div class="eyebrow">${p.unlimited.name}</div>
      <div class="price">$199<small> / year</small></div>
      <ul><li>Unlimited publishers and apps</li><li>Shared orgs with invited members</li><li>Teams and projects</li><li>Everything in Pro</li></ul>
      <a class="btn dark" href="/console/billing?plan=unlimited">Get Unlimited</a>
    </div>
  </div>
  <section class="block"><div class="bigrow">
    <div class="tile"><div class="k">Limits</div><h3>Counted per account</h3><p>Publishers and apps across every org you created. A lapsed plan never takes a live listing down; it only stops new ones.</p></div>
    <div class="tile"><div class="k">Payments</div><h3>CoinPay</h3><p>USDC, BTC, ETH, SOL and more. One payment adds a year.</p></div>
    <div class="tile"><div class="k">Get featured</div><h3>$19, one time</h3><p>A week on the home page's Featured row and at the top of the store, plus a slot in the next newsletter. <a href="/featured">How it works →</a></p></div>
    <div class="tile"><div class="k">Your app</div><h3>Keep 100%</h3><p>pwamart only lists and installs. Subscriptions inside your app are between you and your users.</p></div>
  </div></section>
</div>`;
  return layout({ title: 'Pricing', path: '/pricing', body, stats });
}

/* ---------------------------------------------------------- developers -- */

export function developersPage({ stats }) {
  const site = config.siteUrl;
  const body = `<div class="wrap" style="max-width:900px">
  <section class="block" style="padding-top:48px">
    <div class="eyebrow">Developers</div>
    <h1 style="margin:10px 0 14px">List a PWA in about two minutes.</h1>
    <p class="lede">Paste your app's URL. pwamart reads your manifest, grades installability, and builds the listing. Prove you own the domain and publish.</p>
  </section>
  <section class="block" id="submit"><h2>1 · Submit</h2>
    <p>In the <a href="/console/submit">console</a>, or from a terminal:</p>
    <div class="term"><div><span class="p">$</span> npx -y @profullstack/pwamart login</div><div><span class="p">$</span> pwamart submit https://your.app --publisher you</div></div>
    <p>Required to publish: HTTPS, a linked manifest with <code>name</code>, 192 and 512px icons, <code>display: standalone</code> and a same-origin <code>start_url</code>. A service worker, a maskable icon, screenshots and an <code>id</code> are recommended and shown on your page.</p>
  </section>
  <section class="block" id="verify"><h2>2 · Verify the domain</h2>
    <p>Any one of these, with the token from your app's page in the console:</p>
    <ul>
      <li><code>https://your.app/.well-known/pwamart.txt</code> containing the token</li>
      <li><code>&lt;meta name="pwamart-verification" content="TOKEN"&gt;</code> in the page head</li>
      <li>DNS TXT <code>_pwamart.your.app</code> = <code>pwamart-verification=TOKEN</code></li>
    </ul>
    <p>Then <code>pwamart verify your-app</code> and <code>pwamart publish your-app</code>.</p>
  </section>
  <section class="block" id="badge"><h2>3 · Link to your listing</h2>
    <p>The same size as the App Store and Google Play buttons (135 × 40), in dark and light, as SVG or PNG at 1x/2x/3x. Every app page has a builder with the snippets filled in and a ready post for X, Bluesky, LinkedIn and the rest.</p>
    <p style="display:flex;gap:12px;flex-wrap:wrap"><img src="/badges/get-it-on-pwamart.svg" alt="Get it on pwamart" width="135" height="40"><img src="/badges/get-it-on-pwamart-light.svg" alt="Get it on pwamart" width="135" height="40"></p>
    <div class="term"><div>[![Get it on pwamart](${e(site)}/badges/get-it-on-pwamart.svg)](${e(site)}/apps/YOUR-SLUG)</div></div>
    <div class="term" style="margin-top:10px"><div>&lt;a href="${e(site)}/apps/YOUR-SLUG"&gt;&lt;img src="${e(site)}/badges/get-it-on-pwamart.svg" alt="Get it on pwamart" width="135" height="40"&gt;&lt;/a&gt;</div></div>
  </section>
  <section class="block" id="cli"><h2>CLI &amp; TUI</h2>
    <div class="term">
      <div><span class="p">$</span> curl -fsSL ${e(site)}/install.sh | sh</div>
      <div><span class="p">$</span> pwamart search "markdown editor"</div>
      <div><span class="p">$</span> pwamart info &lt;slug&gt;</div>
      <div><span class="p">$</span> pwamart install &lt;slug&gt;   <span class="p"># opens as an app window, writes a launcher entry</span></div>
      <div><span class="p">$</span> pwamart tui                <span class="p"># the store on hqtui</span></div>
    </div>
    <p>Installs use TronBrowser (<code>tron --app=…</code>) when it is present, otherwise Chrome, Chromium, Edge or Brave in app mode.</p>
  </section>
  <section class="block" id="mcp"><h2>MCP</h2>
    <div class="term"><div><span class="p">$</span> claude mcp add pwamart -- npx -y @profullstack/pwamart-mcp</div></div>
    <p>Or the hosted endpoint, no install: <code>${e(site)}/mcp</code> (streamable HTTP). Tools: <code>search_apps</code>, <code>get_app</code>, <code>list_categories</code>, <code>install_app</code>, plus <code>submit_app</code>, <code>verify_app</code> and <code>publish_app</code> with <code>PWAMART_API_KEY</code>.</p>
  </section>
  <section class="block" id="api"><h2>API</h2>
    <p>Base <code>${e(site)}/api/v1</code>. Reads are public; writes take <code>Authorization: Bearer pm_live_…</code> from the console's API keys page. The full list is in <a href="/llms.txt">llms.txt</a>.</p>
    <div class="term">
      <div><span class="p">GET</span>  /apps?q=&amp;category=&amp;sort=top|new|rating</div>
      <div><span class="p">GET</span>  /apps/:slug</div>
      <div><span class="p">POST</span> /apps                  <span class="p">{publisher, url}</span></div>
      <div><span class="p">POST</span> /apps/:slug/verify · /publish</div>
    </div>
  </section>
  <section class="block" id="desktop"><h2>pwamart Desktop</h2>
    <p>An Electron app that browses the store and installs any listing as its own window with a launcher icon, on any OS, whatever your default browser is. It carries the CLI too. Downloads are on <a href="https://github.com/profullstack/pwamart.com/releases">GitHub releases</a>.</p>
  </section>
</div>`;
  return layout({ title: 'Developers', path: '/developers', body, stats });
}

export function notFoundPage({ stats }) {
  return layout({
    title: 'Not found',
    body: `<div class="wrap"><section class="block" style="padding:80px 0;text-align:center"><div class="eyebrow">404</div><h1 style="margin:10px 0 16px">That page is not in the store.</h1><a class="btn primary" href="/apps">Browse apps</a></section></div>`,
    stats,
    noindex: true,
  });
}

/* -------------------------------------------------- featured + newsletter -- */

const subscribeForm = (source) => `<form method="post" action="/newsletter" style="max-width:520px;margin:18px 0 0;display:flex;gap:8px;flex-wrap:wrap">
    <input type="hidden" name="source" value="${e(source)}">
    <input name="email" type="email" required placeholder="you@example.com" aria-label="Email address" autocomplete="email" style="flex:1;min-width:220px;padding:12px 14px;border-radius:12px;border:1px solid rgba(127,127,127,.35);font:inherit;background:transparent;color:inherit">
    <button class="btn primary" type="submit">Subscribe</button>
  </form>`;

export function featuredPage({ stats, featured = [], subscribers = 0, priceCents = 1900, days = 7 }) {
  const price = `$${priceCents / 100}`;
  const body = `<div class="wrap" style="max-width:900px">
  <section class="block" style="padding-top:48px">
    <div class="eyebrow">For publishers</div>
    <h1 style="margin:10px 0 14px">Get featured on pwamart and in our newsletter for ${price}.</h1>
    <p class="lede">One payment, in crypto through CoinPay. Your app gets the home page's Featured row and the top of the store for ${days} days, and a spot at the top of the next pwamart newsletter.</p>
    <p style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap"><a class="btn primary" href="/console/feature">Feature an app for ${price}</a><a class="btn" href="/console/submit">List an app first</a></p>
  </section>
  <section class="block"><div class="bigrow">
    <div class="tile"><div class="k">Home page</div><h3>${days} days</h3><p>The Featured row on pwamart.com, and first place in the default sort. Buy again while it runs and the time adds on.</p></div>
    <div class="tile"><div class="k">Newsletter</div><h3>The next issue</h3><p>Featured apps lead the issue, ahead of the week's new listings${subscribers ? `, to ${e(subscribers)} confirmed readers` : ''}.</p></div>
    <div class="tile"><div class="k">Payment</div><h3>${price} in crypto</h3><p>USDC, BTC, ETH, SOL and more through CoinPay. It goes live the moment the payment settles.</p></div>
  </div></section>
  <section class="block">
    <h2>How it works</h2>
    <ol class="muted" style="line-height:1.8">
      <li>List your web app (free) and publish it.</li>
      <li>In the console, open the app and choose <b>Get featured · ${price}</b>, or run <code>pwamart feature &lt;slug&gt;</code>.</li>
      <li>Pay with CoinPay. The app is featured as soon as the payment settles.</li>
    </ol>
  </section>
  ${
    featured.length
      ? `<section class="block"><div class="block-head"><h2>Featured right now</h2></div><p>${featured.map((a) => `<a href="/apps/${e(a.slug)}">${e(a.name)}</a>`).join(' · ')}</p></section>`
      : ''
  }
  <section class="block"><h2>Read it yourself</h2><p class="muted">New and featured web apps, about once a week.</p>${subscribeForm('featured')}</section>
</div>`;
  return layout({
    title: `Get featured for ${price}`,
    description: `Feature your web app on pwamart's home page for ${days} days and in the next pwamart newsletter for ${price}, paid in crypto.`,
    path: '/featured',
    body,
    stats,
  });
}

export function newsletterPage({ stats, notice = null, tone = '' }) {
  const body = `<div class="wrap" style="max-width:760px">
  <section class="block" style="padding-top:48px">
    <div class="eyebrow">Newsletter</div>
    <h1 style="margin:10px 0 14px">New and featured web apps, about once a week.</h1>
    <p class="lede">Apps you install from the browser: no app store, no review queue. One email a week at most, and one tap to leave.</p>
    ${notice ? `<p role="status" style="font-weight:600;margin-top:18px;${tone === 'bad' ? 'color:#c0392b' : ''}">${e(notice)}</p>` : ''}
    ${subscribeForm('newsletter')}
  </section>
  <section class="block"><p class="muted">Publishers: <a href="/featured">get your app into the next issue and onto the home page for $19 →</a></p></section>
</div>`;
  return layout({ title: 'Newsletter', description: 'The pwamart newsletter: new and featured Progressive Web Apps, about once a week.', path: '/newsletter', body, stats });
}
