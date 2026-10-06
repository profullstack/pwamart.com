/**
 * pwamart store: the Install button and a few small enhancements. The pages
 * work without this file; it only makes Install do the best thing each browser
 * allows.
 *
 * A store cannot silently install someone else's web app. What it CAN do:
 *  - the Web Install API (navigator.install) where a browser ships it: one click;
 *  - our own desktop app / TronBrowser, which open the app as its own window;
 *  - otherwise open the app and show the two taps that browser needs.
 */

const $ = (s, el = document) => el.querySelector(s);
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isEdge = /Edg\//.test(ua);
const isFirefox = /Firefox\//.test(ua);
const isSamsung = /SamsungBrowser/.test(ua);
const isChromium = !!window.chrome || /Chrome\//.test(ua);
const isSafariMac = !isIOS && /Safari\//.test(ua) && !isChromium && !isFirefox;
// pwamart Desktop and TronBrowser announce themselves in the UA or a query flag.
const inDesktop = /pwamart-desktop/i.test(ua) || !!window.pwamart?.install;
const inTron = /TronBrowser/i.test(ua) || new URLSearchParams(location.search).get('via') === 'tron';
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

async function count(slug, method) {
  try {
    await fetch(`/api/v1/apps/${encodeURIComponent(slug)}/installs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method }),
      keepalive: true,
    });
  } catch {}
}

const SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
const DOTS = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const MONITOR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M12 8v6m-3-3 3 3 3-3"/></svg>';
const g = (svg) => `<span class="glyph">${svg}</span>`;

function sheet(app, { title, steps, actions = '', foot = '' }) {
  const d = $('#sheet');
  $('#sheet-in').innerHTML = `
    <div class="sheet-head">
      ${app.icon ? `<img class="icon" src="${esc(app.icon)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div><div class="eyebrow">Install</div><h3>${esc(title ?? app.name)}</h3></div>
    </div>
    <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    <div class="sheet-actions">${actions}<button class="btn" value="close" formmethod="dialog" type="button" data-close>Done</button></div>
    ${foot ? `<p class="muted" style="font-size:13px;margin:14px 0 0">${foot}</p>` : ''}`;
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  d.addEventListener('click', (ev) => ev.target === d && d.close(), { once: true });
  d.showModal();
}

async function install(app) {
  const open = `<a class="btn primary" href="${esc(app.start_url)}" target="_blank" rel="noopener" data-open>Open app</a>`;

  // 1. Inside pwamart Desktop: the app installs it as a real window + launcher icon.
  if (inDesktop && window.pwamart?.install) {
    await window.pwamart.install({ slug: app.slug, url: app.start_url, name: app.name, icon: app.icon });
    count(app.slug, 'desktop');
    return toast(`${app.name} installed`);
  }

  // 2. The Web Install API: a store-initiated install, one click.
  if ('install' in navigator && typeof navigator.install === 'function') {
    try {
      await navigator.install(app.start_url, app.manifest_id || app.start_url);
      count(app.slug, 'web');
      return toast(`${app.name} installed`);
    } catch (err) {
      if (err?.name === 'AbortError') return; // the person said no
      // fall through to the guided path
    }
  }

  // 3. TronBrowser: its launcher opens a URL as an app window.
  if (inTron) {
    count(app.slug, 'tron');
    return sheet(app, {
      steps: [
        `Open it as an app window from a terminal:<br><code>tron --app=${esc(app.start_url)}</code>`,
        `Or open it below and choose ${g(MONITOR)} <b>Install</b> in the address bar.`,
        `Keep the icon pointing at TronBrowser: <code>tron pwa sync</code>`,
      ],
      actions: open,
    });
  }

  if (isIOS) {
    count(app.slug, 'ios');
    return sheet(app, {
      steps: [
        `Open <b>${esc(app.name)}</b> in Safari.`,
        `Tap ${g(SHARE)} <b>Share</b>.`,
        `Tap ${g(PLUS)} <b>Add to Home Screen</b>, then <b>Add</b>.`,
      ],
      actions: `${open}<a class="btn" href="/apps/${esc(app.slug)}/install.mobileconfig" data-profile>One-tap profile</a>`,
      foot: 'The one-tap profile adds the icon from Settings → Profile Downloaded. Remove it any time under Settings → General → VPN &amp; Device Management.',
    });
  }

  if (isAndroid) {
    count(app.slug, 'android');
    return sheet(app, {
      steps: [
        `Open <b>${esc(app.name)}</b>.`,
        isSamsung
          ? `Tap the ${g(MONITOR)} <b>install</b> icon in the address bar, or menu → <b>Add page to</b> → <b>Apps screen</b>.`
          : isFirefox
            ? `Tap ${g(DOTS)} → <b>Add to Home screen</b> (or <b>Install</b>).`
            : `Tap <b>Install</b> when Chrome offers it, or ${g(DOTS)} → <b>Add to Home screen</b> → <b>Install</b>.`,
        'It lands in your app drawer and opens without browser bars.',
      ],
      actions: open,
    });
  }

  if (isFirefox) {
    count(app.slug, 'web');
    return sheet(app, {
      steps: [
        'Firefox on Windows can pin web apps to the taskbar; on macOS and Linux it cannot install them.',
        `Use <a href="/developers#desktop">pwamart Desktop</a>, Chrome or Edge, or from a terminal:<br><code>npx -y @profullstack/pwamart install ${esc(app.slug)}</code>`,
      ],
      actions: open,
    });
  }

  if (isSafariMac) {
    count(app.slug, 'web');
    return sheet(app, {
      steps: [`Open <b>${esc(app.name)}</b> in Safari.`, `Choose <b>File → Add to Dock</b>.`, 'It opens as its own app from the Dock and Launchpad.'],
      actions: open,
    });
  }

  // Desktop Chrome, Edge, Brave, Opera, Vivaldi.
  count(app.slug, 'web');
  sheet(app, {
    steps: [
      `Open <b>${esc(app.name)}</b>.`,
      isEdge
        ? `Click ${g(PLUS)} <b>App available</b> in the address bar, then <b>Install</b>.`
        : `Click ${g(MONITOR)} <b>Install</b> at the right end of the address bar (or ${g(DOTS)} → <b>Cast, save and share</b> → <b>Install page as app</b>).`,
      'It gets its own window, icon and launcher entry.',
    ],
    actions: open,
    foot: `From a terminal: <code>npx -y @profullstack/pwamart install ${esc(app.slug)}</code>`,
  });
}

const btn = $('#install');
if (btn) {
  const app = JSON.parse(btn.dataset.app);
  btn.addEventListener('click', () => install(app));
  const hint = $('#install-hint');
  if (hint) {
    if (inDesktop) hint.textContent = 'Installs as its own window';
    else if ('install' in navigator) hint.textContent = 'One click: your browser installs it';
    else if (isIOS) hint.textContent = 'Two taps in Safari, or a one-tap profile';
    else if (isAndroid) hint.textContent = 'Lands in your app drawer';
    else if (inTron) hint.textContent = 'Opens as a TronBrowser app window';
  }
  $('#open')?.addEventListener('click', () => count(app.slug, 'open'));
}

// Reviews: post through the API; a 401 sends you to sign in and back.
const review = $('#review');
review?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(review);
  const res = await fetch(`/api/v1/apps/${encodeURIComponent(review.dataset.slug)}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rating: Number(f.get('rating')), body: f.get('body') }),
  });
  if (res.status === 401) return location.assign(`/signin?next=${encodeURIComponent(location.pathname)}`);
  if (res.ok) return location.reload();
  toast((await res.json().catch(() => ({}))).error ?? 'Could not post that');
});

// Install pwamart itself.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (standalone) document.documentElement.classList.add('standalone');

// An app's own manifest can point at an icon that 404s; show its initial instead of a broken image.
for (const img of document.querySelectorAll('img.icon')) {
  const swap = () => {
    const ph = document.createElement('span');
    ph.className = `${img.className} ph`;
    ph.style.cssText = `width:${img.width}px;height:${img.height}px`;
    ph.textContent = (img.closest('a,section,div')?.querySelector('.name,h1,h3')?.textContent ?? '?').trim().charAt(0).toUpperCase();
    img.replaceWith(ph);
  };
  if (img.complete && img.naturalWidth === 0) swap();
  else img.addEventListener('error', swap, { once: true });
}
