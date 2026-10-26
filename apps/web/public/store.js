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
  if (res.status === 401) return askSignin(review);
  if (res.ok) return location.reload();
  toast((await res.json().catch(() => ({}))).error ?? 'Could not post that');
});

/**
 * Signed out: show the sign-in prompt (CoinPay or an emailed link, both back to this
 * page) next to what was clicked, instead of losing the reader to another page.
 */
function askSignin(near) {
  const prompt = (near?.closest('section, .install-box, .panel') ?? document).querySelector('[data-signin-prompt]') ?? $('[data-signin-prompt]');
  if (!prompt) return location.assign(`/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
  const next = encodeURIComponent(location.pathname + location.hash);
  prompt.querySelectorAll('a').forEach((a) => (a.href = a.href.replace(/next=[^&]*/, `next=${next}`)));
  prompt.hidden = false;
  prompt.classList.add('flash');
  prompt.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
const karmaToast = (k) => {
  if (k?.paid) toast(`+${k.points} karma`);
};

// Upvote: one per member, toggles; the count follows the server.
const upvoteBtn = $('#upvote');
if (upvoteBtn) {
  const slug = upvoteBtn.dataset.slug;
  const paint = (st) => {
    upvoteBtn.setAttribute('aria-pressed', String(st.voted));
    upvoteBtn.classList.toggle('on', st.voted);
    document.querySelectorAll('[data-votes]').forEach((el) => (el.textContent = st.votes));
  };
  fetch(`/api/v1/apps/${encodeURIComponent(slug)}/vote`)
    .then((r) => r.json())
    .then((st) => {
      paint(st);
      if (st.signed_in) document.querySelectorAll('[data-signin-prompt]').forEach((p) => (p.hidden = true));
    })
    .catch(() => {});
  upvoteBtn.addEventListener('click', async () => {
    const on = upvoteBtn.getAttribute('aria-pressed') === 'true';
    const res = await fetch(`/api/v1/apps/${encodeURIComponent(slug)}/vote`, { method: on ? 'DELETE' : 'POST' });
    if (res.status === 401) return askSignin(upvoteBtn);
    const st = await res.json().catch(() => ({}));
    if (!res.ok) return toast(st.error ?? 'Could not vote');
    paint(st);
    karmaToast(st.karma);
  });
}

// Card upvotes (/apps, home, publisher pages): one request learns which cards the
// reader already voted; a click votes or takes it back, and a paid vote toasts +1 karma.
const cardVotes = [...document.querySelectorAll('[data-card-vote]')];
if (cardVotes.length) {
  const paintCard = (btn, st) => {
    btn.setAttribute('aria-pressed', String(st.voted));
    btn.classList.toggle('on', st.voted);
    if (st.votes != null) btn.querySelector('b').textContent = st.votes;
  };
  const slugs = [...new Set(cardVotes.map((b) => b.dataset.cardVote))].slice(0, 100);
  fetch(`/api/v1/votes?apps=${slugs.map(encodeURIComponent).join(',')}`)
    .then((r) => r.json())
    .then(({ voted }) => cardVotes.forEach((b) => (voted ?? []).includes(b.dataset.cardVote) && paintCard(b, { voted: true })))
    .catch(() => {});
  for (const btn of cardVotes) {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const slug = btn.dataset.cardVote;
      const on = btn.getAttribute('aria-pressed') === 'true';
      btn.disabled = true;
      try {
        const res = await fetch(`/api/v1/apps/${encodeURIComponent(slug)}/vote`, { method: on ? 'DELETE' : 'POST' });
        if (res.status === 401) return askSignin(btn);
        const st = await res.json().catch(() => ({}));
        if (!res.ok) return toast(st.error ?? 'Could not vote');
        // The same app can sit in two grids on one page (home: featured + top).
        cardVotes.filter((b) => b.dataset.cardVote === slug).forEach((b) => paintCard(b, st));
        karmaToast(st.karma);
      } finally {
        btn.disabled = false;
      }
    });
  }
}

// Comments: post, reply (one level), delete your own.
const comments = $('#comments');
if (comments) {
  const slug = comments.dataset.slug;
  const form = $('#comment-form');
  const parent = form.querySelector('[name=parent]');
  const replying = form.querySelector('.replying');
  const reply = (id) => {
    parent.value = id;
    replying.hidden = false;
    form.querySelector('textarea').focus();
  };
  form.querySelector('[data-cancel-reply]').addEventListener('click', (ev) => {
    ev.preventDefault();
    parent.value = '';
    replying.hidden = true;
  });
  fetch(`/api/v1/apps/${encodeURIComponent(slug)}/comments`)
    .then((r) => r.json())
    .then(({ comments: list, signed_in }) => {
      if (signed_in) document.querySelectorAll('[data-signin-prompt]').forEach((p) => (p.hidden = true));
      const all = (list ?? []).flatMap((c) => [c, ...(c.replies ?? [])]);
      for (const c of all) {
        const acts = comments.querySelector(`[data-comment-id="${CSS.escape(c.id)}"] [data-comment-acts]`);
        if (!acts) continue;
        if (!c.parent_id) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'linkish';
          b.textContent = 'Reply';
          b.addEventListener('click', () => (signed_in ? reply(c.id) : askSignin(comments)));
          acts.append(b);
        }
        if (c.can_delete) {
          const d = document.createElement('button');
          d.type = 'button';
          d.className = 'linkish';
          d.textContent = c.mine ? 'Delete' : 'Delete (staff)';
          d.addEventListener('click', async () => {
            if (!confirm('Delete this comment? Its karma goes back.')) return;
            const r = await fetch(`/api/v1/comments/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
            if (r.ok) location.reload();
            else toast((await r.json().catch(() => ({}))).error ?? 'Could not delete it');
          });
          acts.append(d);
        }
      }
    })
    .catch(() => {});
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const res = await fetch(`/api/v1/apps/${encodeURIComponent(slug)}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: f.get('body'), parent: f.get('parent') || undefined }),
    });
    if (res.status === 401) return askSignin(form);
    const r = await res.json().catch(() => ({}));
    if (!res.ok) return toast(r.error ?? 'Could not post that');
    karmaToast(r.comment?.karma);
    setTimeout(() => location.reload(), r.comment?.karma?.paid ? 700 : 0);
  });
}

// Share clicks are tracked (signed in, they earn karma); the link still opens as normal.
const trackShare = (network) => {
  const slug = $('#upvote')?.dataset.slug ?? $('#comments')?.dataset.slug;
  if (!slug) return;
  fetch(`/api/v1/apps/${encodeURIComponent(slug)}/share`, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ network }),
  })
    .then((r) => r.json())
    .then((r) => karmaToast(r.karma))
    .catch(() => {});
};
document.querySelectorAll('#share [data-net]').forEach((a) => a.addEventListener('click', () => trackShare(a.dataset.net)));
document.querySelector('#share [data-copy-post]')?.addEventListener('click', () => trackShare('copy'));

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

// Share + badge builder (app pages): copy buttons, dark/light badge, live post links.
const share = document.getElementById('share');
if (share) {
  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = was), 1400);
  };
  share.querySelectorAll('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', () => copy(btn.closest('.snip').querySelector('code').textContent, btn)),
  );
  share.querySelectorAll('[data-theme]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const theme = btn.dataset.theme;
      share.querySelectorAll('[data-theme]').forEach((b) => {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      const img = share.querySelector('[data-badge] img');
      img.src = img.dataset[theme];
      share.querySelectorAll('code[data-dark]').forEach((c) => (c.textContent = c.dataset[theme]));
    }),
  );
  const post = share.querySelector('#share-post');
  const page = post.dataset.page;
  const title = post.dataset.title;
  const enc = encodeURIComponent;
  const hrefs = {
    x: (t) => `https://x.com/intent/post?text=${enc(t)}`,
    bluesky: (t) => `https://bsky.app/intent/compose?text=${enc(t)}`,
    email: (t) => `mailto:?subject=${enc(title)}&body=${enc(t)}`,
  };
  post.addEventListener('input', () => {
    for (const [net, f] of Object.entries(hrefs)) share.querySelector(`[data-net="${net}"]`).href = f(post.value);
  });
  share.querySelector('[data-copy-post]').addEventListener('click', (ev) => copy(post.value, ev.currentTarget));
  const native = share.querySelector('[data-native-share]');
  if (navigator.share) {
    native.hidden = false;
    native.addEventListener('click', () => navigator.share({ title, text: post.value, url: page }).catch(() => {}));
  }
}

// Share (publisher pages): each click copies the next canned post, from a random start,
// so people sharing the same page do not all post the same words.
for (const btn of document.querySelectorAll('[data-share-posts]')) {
  let posts = [];
  try {
    posts = JSON.parse(btn.dataset.sharePosts);
  } catch {}
  if (!posts.length) continue;
  let i = Math.floor(Math.random() * posts.length);
  btn.addEventListener('click', async () => {
    const text = posts[i];
    i = (i + 1) % posts.length;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    btn.textContent = 'Copied! Paste anywhere';
    clearTimeout(btn._reset);
    btn._reset = setTimeout(() => (btn.textContent = 'Share'), 1800);
  });
}

// "Get notified": follow an app or publisher by account, email or browser push.
for (const box of document.querySelectorAll('[data-follow-kind]')) {
  const kind = box.dataset.followKind;
  const slug = box.dataset.followSlug;
  const btn = box.querySelector('[data-follow-open]');
  const label = box.querySelector('[data-follow-label]');
  const form = box.querySelector('.follow-form');
  const msg = box.querySelector('.follow-msg');
  const pushBtn = box.querySelector('[data-follow-push]');
  let state = { following: false, signed_in: false };
  const setFollowing = (on) => {
    state.following = on;
    label.textContent = on ? 'Following' : 'Get notified';
    btn.classList.toggle('dark', on);
  };
  const post = (body) =>
    fetch('/api/v1/follow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, slug, ...body }) }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'could not follow');
      return j;
    });
  let push = null;
  try {
    push = await import('/assets/push-client.js');
  } catch {}
  const support = push?.pushSupport?.();
  if (support?.supported) pushBtn.hidden = false;
  let endpoint = '';
  try {
    endpoint = (await push?.getSubscription?.())?.endpoint ?? '';
  } catch {}
  fetch(`/api/v1/follow/state?kind=${kind}&slug=${encodeURIComponent(slug)}${endpoint ? `&endpoint=${encodeURIComponent(endpoint)}` : ''}`)
    .then((r) => r.json())
    .then((s) => {
      state = { ...state, ...s };
      setFollowing(Boolean(s.following));
    })
    .catch(() => {});

  btn.addEventListener('click', async () => {
    if (state.following && state.id && state.signed_in) {
      await fetch(`/api/v1/follows/${state.id}`, { method: 'DELETE' });
      return setFollowing(false);
    }
    if (state.signed_in) {
      try {
        const r = await post({});
        state.id = r.id;
        setFollowing(true);
      } catch (err) {
        msg.textContent = err.message;
        form.hidden = false;
      }
      return;
    }
    form.hidden = !form.hidden;
  });
  pushBtn.addEventListener('click', async () => {
    try {
      const sub = await push.subscribe({ vapidKeyUrl: '/api/v1/push/vapid-public-key' });
      await post({ push: sub.toJSON ? sub.toJSON() : sub });
      setFollowing(true);
      msg.textContent = 'Done: this browser will show a notification when there is something new.';
    } catch (err) {
      msg.textContent = push?.REASON_MESSAGES?.[err.reason] ?? err.message ?? 'Notifications are not available here.';
    }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = new FormData(form).get('email');
    try {
      const r = await post({ email });
      msg.textContent = r.confirmed ? 'You are following it.' : `Check ${email} for a confirmation link.`;
      if (r.confirmed) setFollowing(true);
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

// Copy buttons on one-liners (the curl install bar).
for (const btn of document.querySelectorAll('[data-copy-text]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copyText);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1500);
    } catch {}
  });
}

// Collections: unticking an app takes it out of the install commands and links.
const col = document.querySelector('[data-collection]');
if (col) {
  const slug = col.dataset.collection;
  const site = col.dataset.site || location.origin;
  const boxes = [...col.querySelectorAll('[data-col-app]')];
  const update = () => {
    const on = boxes.filter((b) => b.checked).map((b) => b.dataset.colApp);
    const qs = on.length === boxes.length ? '' : `?apps=${on.join(',')}`;
    const mcp = boxes.filter((b) => b.checked && b.dataset.mcp).map((b) => b.dataset.mcp).join('\n');
    const set = (key, text) => {
      for (const el of col.querySelectorAll(`[data-col-out="${key}"]`)) el.textContent = text;
      for (const el of col.querySelectorAll(`[data-col-copy="${key}"]`)) el.dataset.copyText = text;
    };
    set('cli', `curl -fsSL ${site}/collections/${slug}/install.sh${qs} | sh`);
    set('mcp', mcp || '# none of the apps you picked has an MCP server');
    for (const a of col.querySelectorAll('[data-col-href]')) {
      const k = a.dataset.colHref;
      a.href = k === 'ios' ? `/bundle.mobileconfig?apps=${on.join(',')}` : `/collections/${slug}/${k}${qs}`;
    }
  };
  for (const b of boxes) b.addEventListener('change', update);
}

// Elsewhere (home, leaderboard): hide the sign-in prompts for a signed-in reader.
if (!$('#upvote') && !$('#comments') && document.querySelector('[data-signin-prompt]')) {
  fetch('/api/v1/karma?limit=1')
    .then((r) => {
      if (r.ok) document.querySelectorAll('[data-signin-prompt]').forEach((p) => (p.hidden = true));
    })
    .catch(() => {});
}
