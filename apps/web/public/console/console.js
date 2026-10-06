/**
 * pwamart console: publishers, apps, orgs, billing and keys. Plain ES module, no
 * build step. Talks only to /api/v1 with the session cookie.
 */

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CATEGORIES = [
  ['productivity', 'Productivity'], ['developer-tools', 'Developer tools'], ['ai', 'AI & agents'], ['communication', 'Communication'],
  ['social', 'Social'], ['media', 'Music & video'], ['news', 'News & reading'], ['finance', 'Finance & crypto'], ['business', 'Business'],
  ['education', 'Education'], ['health', 'Health & fitness'], ['lifestyle', 'Lifestyle'], ['shopping', 'Shopping'],
  ['travel', 'Travel & maps'], ['games', 'Games'], ['utilities', 'Utilities'], ['security', 'Security & privacy'], ['design', 'Design & photo'],
];

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let me = null;

function go(path) {
  history.pushState({}, '', path);
  route();
}
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href^="/console"], a[href="/signin"]');
  if (!a || ev.metaKey || ev.ctrlKey || a.target) return;
  ev.preventDefault();
  go(a.getAttribute('href'));
});
addEventListener('popstate', route);

function nav() {
  $('#nav').innerHTML = me
    ? `<a href="/apps">Store</a><a href="/developers">Docs</a><a class="keep" href="#" id="signout">Sign out</a>`
    : `<a href="/apps">Store</a><a class="cta" href="/signin">Sign in</a>`;
  $('#signout')?.addEventListener('click', async (ev) => {
    ev.preventDefault();
    await api('/auth/signout', { method: 'POST' });
    me = null;
    go('/signin');
  });
  const p = location.pathname;
  const link = (href, text, extra = '') =>
    `<a href="${href}" class="${p === href || (href !== '/console' && p.startsWith(href)) ? 'on' : ''}">${text}${extra}</a>`;
  $('#side').innerHTML = me
    ? [
        link('/console', 'Overview'),
        link('/console/submit', 'Submit an app'),
        link('/console/apps', 'Apps', `<small>${me.usage.apps}</small>`),
        link('/console/publishers', 'Publishers', `<small>${me.usage.publishers}</small>`),
        link('/console/orgs', 'Orgs & teams'),
        '<div class="sep"></div>',
        link('/console/billing', 'Plan & billing', `<small>${esc(me.plan.name)}</small>`),
        link('/console/keys', 'API keys & passkeys'),
      ].join('')
    : '';
}

function errBox(err) {
  return `<p class="err">${esc(err.message)}${err.body?.upgrade ? ` <a href="/console/billing">Upgrade →</a>` : ''}</p>`;
}

/** After sign-in: console paths route in place; anything else on this site (the CLI's consent page) loads for real. */
function goNext(next) {
  const n = next && next.startsWith('/') && !next.startsWith('//') ? next : '/console';
  if (n.startsWith('/console')) return go(n);
  location.assign(n);
}

async function route() {
  const p = location.pathname;
  try {
    if (!me) me = await api('/me').catch((e) => (e.status === 401 ? null : Promise.reject(e)));
  } catch (err) {
    view.innerHTML = errBox(err);
    return;
  }
  if (!me && p !== '/signin') return go(`/signin?next=${encodeURIComponent(p + location.search)}`);
  if (me && p === '/signin') return goNext(new URLSearchParams(location.search).get('next'));
  nav();
  window.scrollTo(0, 0);
  try {
    if (p === '/signin') return signin();
    if (p === '/console') return overview();
    if (p === '/console/submit') return submit();
    if (p === '/console/apps') return appsList();
    if (p.startsWith('/console/apps/')) return appDetail(decodeURIComponent(p.split('/')[3]));
    if (p === '/console/publishers') return publishers();
    if (p === '/console/orgs') return orgsPage();
    if (p.startsWith('/console/orgs/')) return orgDetail(decodeURIComponent(p.split('/')[3]));
    if (p === '/console/billing') return billing();
    if (p === '/console/feature') return featurePick();
    if (p === '/console/keys') return keys();
    if (p.startsWith('/console/claim/')) return claimView(decodeURIComponent(p.split('/')[3]));
    view.innerHTML = '<p>Not found. <a href="/console">Back to the console</a></p>';
  } catch (err) {
    view.innerHTML = errBox(err);
  }
}
async function refreshMe() {
  me = await api('/me');
  nav();
}

/* -------------------------------------------------------------- sign in -- */

function signin() {
  const q = new URLSearchParams(location.search);
  // Remember where sign-in started across the emailed link (the server reads pm_next).
  const nx = q.get('next');
  if (nx && nx.startsWith('/') && !nx.startsWith('//') && !nx.startsWith('/console'))
    document.cookie = `pm_next=${encodeURIComponent(nx)}; Path=/; Max-Age=1800; SameSite=Lax`;
  view.innerHTML = `<div class="signin">
    <div class="eyebrow">Publisher console</div>
    <h1>Sign in to pwamart</h1>
    <p class="muted">No passwords. We email you a link, or use a passkey you saved before.</p>
    ${q.get('error') === 'expired' ? '<p class="err">That link expired or was already used. Send a new one.</p>' : ''}
    <form class="stack" id="f">
      <label class="f">Email<input type="email" name="email" required autocomplete="email webauthn" placeholder="you@company.com"></label>
      <button class="btn primary">Email me a sign-in link</button>
    </form>
    <div class="or">or</div>
    <button class="btn" id="pk" style="width:100%">Sign in with a passkey</button>
    <p id="msg"></p>
  </div>`;
  $('#f').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = new FormData(ev.target).get('email');
    try {
      await api('/auth/link', { method: 'POST', body: { email } });
      $('#msg').innerHTML = `<span class="ok-msg">Check ${esc(email)} for a link. It works once and lasts 20 minutes.</span>`;
    } catch (err) {
      $('#msg').innerHTML = errBox(err);
    }
  });
  $('#pk').addEventListener('click', async () => {
    try {
      if (!window.SimpleWebAuthnBrowser) throw new Error('Passkeys are not available in this browser');
      const { options, challengeId } = await api('/auth/passkey/login/options', { method: 'POST' });
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      await api('/auth/passkey/login/verify', { method: 'POST', body: { response, challengeId } });
      me = null;
      goNext(q.get('next'));
    } catch (err) {
      $('#msg').innerHTML = errBox(err);
    }
  });
}

/* ------------------------------------------------------------- overview -- */

const meter = (used, limit) =>
  limit === null ? '<span class="muted" style="font-size:13px">unlimited</span>' : `<div class="meter"><i style="width:${Math.min(100, (used / limit) * 100)}%"></i></div>`;

async function overview() {
  const { apps } = await api('/me/apps');
  const pl = me.plan;
  view.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">${esc(me.user.email)}</div><h1>Overview</h1></div>
      <a class="btn primary" href="/console/submit">Submit an app</a></div>
    <div class="kpis">
      <div class="kpi"><span>Plan</span><b>${esc(pl.name)}</b>${pl.paid_through ? `<small class="muted">through ${esc(pl.paid_through.slice(0, 10))}</small>` : '<a href="/console/billing" style="font-size:13px">Upgrade →</a>'}</div>
      <div class="kpi"><span>Publishers</span><b>${me.usage.publishers}${pl.publishers !== null ? ` / ${pl.publishers}` : ''}</b>${meter(me.usage.publishers, pl.publishers)}</div>
      <div class="kpi"><span>Apps</span><b>${me.usage.apps}${pl.apps !== null ? ` / ${pl.apps}` : ''}</b>${meter(me.usage.apps, pl.apps)}</div>
      <div class="kpi"><span>Installs</span><b>${apps.reduce((n, a) => n + a.installs, 0)}</b><small class="muted">across your apps</small></div>
    </div>
    ${
      me.publishers.length
        ? ''
        : `<div class="panel" style="margin-bottom:22px"><h3>Start with a publisher</h3><p class="muted">A publisher is the name your apps are listed “by”. Your first one is free.</p><a class="btn dark sm" href="/console/publishers">Create a publisher</a></div>`
    }
    <h2 style="margin-bottom:12px">Your apps</h2>
    ${appsTable(apps)}`;
}

function appsTable(apps) {
  if (!apps.length) return '<div class="empty">No apps yet. <a href="/console/submit">Submit your first PWA</a>.</div>';
  return `<div class="table-wrap"><table class="table"><thead><tr><th>App</th><th>Publisher</th><th>Status</th><th>Score</th><th>Installs</th></tr></thead><tbody>
    ${apps
      .map(
        (a) => `<tr>
        <td><a href="/console/apps/${esc(a.slug)}" style="text-decoration:none;font-weight:600">${a.icon ? `<img class="icon" src="${esc(a.icon)}" alt="" referrerpolicy="no-referrer">` : ''}${esc(a.name)}</a></td>
        <td>${esc(a.publisher.name)}</td>
        <td><span class="pill ${esc(a.status)}">${esc(a.status)}</span> ${a.verified ? '' : '<span class="pill">unverified</span>'}</td>
        <td>${a.score ?? '–'}%</td>
        <td>${a.installs}</td></tr>`,
      )
      .join('')}
  </tbody></table></div>`;
}

async function appsList() {
  const { apps } = await api('/me/apps');
  view.innerHTML = `<div class="page-head"><h1>Apps</h1><a class="btn primary" href="/console/submit">Submit an app</a></div>${appsTable(apps)}`;
}

/* --------------------------------------------------------------- submit -- */

function checksList(checks) {
  return `<ul class="checks">${checks
    .map((c) => `<li><span class="${c.ok ? 'ok' : c.level === 'required' ? 'no' : 'rec'}">${c.ok ? '✓' : c.level === 'required' ? '✕' : '○'}</span><span>${esc(c.label)}${c.ok ? '' : `<br><small class="muted">${esc(c.hint)}</small>`}</span></li>`)
    .join('')}</ul>`;
}

async function submit() {
  if (!me.publishers.length) {
    view.innerHTML = `<div class="page-head"><h1>Submit an app</h1></div>
      <div class="panel"><h3>First, a publisher</h3><p class="muted">Apps are listed under a publisher: your name, studio or company.</p>
      ${publisherForm()}</div>`;
    bindPublisherForm(() => go('/console/submit'));
    return;
  }
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Step 1 of 3</div><h1>Submit an app</h1></div></div>
    <form class="stack" id="f">
      <label class="f">App URL <small>The page that links your web app manifest, usually your home page.</small>
        <input name="url" type="url" required placeholder="https://your.app" inputmode="url"></label>
      <label class="f">Publisher<select name="publisher">${me.publishers.map((p) => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="f">Category<select name="category"><option value="">Guess from the manifest</option>${CATEGORIES.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select></label>
      <div class="row"><button class="btn" type="button" id="check">Check installability</button><button class="btn primary">Create listing</button></div>
      <div id="out"></div>
    </form>`;
  const f = $('#f');
  $('#check').addEventListener('click', async () => {
    const url = new FormData(f).get('url');
    if (!url) return f.reportValidity();
    $('#out').innerHTML = '<p class="muted">Fetching your page and manifest…</p>';
    try {
      const r = await api('/inspect', { method: 'POST', body: { url } });
      $('#out').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between">
        <div class="row">${r.app.icon ? `<img class="icon" src="${esc(r.app.icon)}" width="48" height="48" alt="" referrerpolicy="no-referrer">` : ''}<div><b>${esc(r.app.name)}</b><br><small class="muted">${esc(r.origin)}</small></div></div>
        <span class="pill ${r.installable ? 'published' : 'unlisted'}">${r.installable ? 'installable' : 'not yet installable'} · ${r.score}%</span></div>
        <div style="margin-top:14px">${checksList(r.checks)}</div></div>`;
    } catch (err) {
      $('#out').innerHTML = errBox(err);
    }
  });
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    $('#out').innerHTML = '<p class="muted">Inspecting and creating the listing…</p>';
    try {
      const r = await api('/apps', { method: 'POST', body: { url: d.url, publisher: d.publisher, category: d.category || undefined } });
      await refreshMe();
      go(`/console/apps/${r.app.slug}`);
    } catch (err) {
      $('#out').innerHTML = errBox(err);
    }
  });
}

/* ------------------------------------------------------------ app detail -- */

async function appDetail(slug) {
  const { app, verify } = await api(`/apps/${encodeURIComponent(slug)}/manage`);
  const step = !app.verified ? 2 : app.status !== 'published' ? 3 : null;
  view.innerHTML = `
    <div class="page-head"><div class="row">${app.icon ? `<img class="icon" src="${esc(app.icon)}" width="64" height="64" alt="" referrerpolicy="no-referrer">` : ''}
      <div>${step ? `<div class="eyebrow">Step ${step} of 3</div>` : `<div class="eyebrow">Live</div>`}<h1>${esc(app.name)}</h1></div></div>
      <div class="row"><span class="pill ${esc(app.status)}">${esc(app.status)}</span>
      ${app.status !== 'draft' ? `<a class="btn sm" href="/apps/${esc(app.slug)}" target="_blank">View listing ↗</a>` : ''}</div></div>

    ${
      !app.verified
        ? `<div class="panel" style="margin-bottom:18px"><h3>Prove you own ${esc(app.origin)}</h3><p class="muted">Do any one of these, then press Verify.</p>
        ${verify.options.map((o) => `<p style="margin:10px 0 4px"><b>${esc(o.method)}</b></p><div class="code-block">${esc(o.how)}</div>`).join('')}
        <div class="row" style="margin-top:14px"><button class="btn dark" id="verify">Verify</button><span id="vmsg"></span></div></div>`
        : ''
    }

    <div class="panel" style="margin-bottom:18px">
      <div class="row" style="justify-content:space-between"><h3>Installability · ${app.score ?? '–'}%</h3><button class="btn sm" id="refresh">Re-check manifest</button></div>
      ${checksList(app.checks)}
    </div>

    <div class="row" style="margin-bottom:22px">
      ${app.status !== 'published' ? `<button class="btn primary" id="publish" ${app.verified && app.installable !== false ? '' : 'disabled'}>Publish to the store</button>` : '<button class="btn" id="unlist">Unlist</button><button class="btn" id="unpublish">Back to draft</button>'}
      ${me.user.admin ? `<button class="btn" id="feature">${app.featured ? 'Unfeature' : 'Feature'} (staff)</button>${app.verified ? '' : '<button class="btn" id="staffverify">Verify (staff)</button>'}` : ''}
      <span id="pmsg"></span>
    </div>

    ${app.status === 'published' ? '<div class="panel" id="featured-panel" style="margin-bottom:22px"><p class="muted">Loading…</p></div>' : ''}

    <h2 style="margin-bottom:12px">Listing</h2>
    <form class="stack" id="edit">
      <label class="f">Name<input name="name" value="${esc(app.name)}" maxlength="80"></label>
      <label class="f">Summary <small>One line on cards, 140 characters.</small><input name="summary" value="${esc(app.summary ?? '')}" maxlength="140"></label>
      <label class="f">Description<textarea name="description" maxlength="8000">${esc(app.description ?? '')}</textarea></label>
      <label class="f">Category<select name="category">${CATEGORIES.map(([k, n]) => `<option value="${k}" ${k === app.category ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <label class="f">Tags <small>Comma separated, up to 10.</small><input name="tags" value="${esc(app.tags.join(', '))}"></label>
      <div class="row"><button class="btn dark">Save</button><span id="emsg"></span></div>
    </form>
    <div class="panel" style="margin-top:28px"><h3>Share it</h3>
      <div class="code-block">&lt;a href="${esc(location.origin)}/apps/${esc(app.slug)}"&gt;&lt;img src="${esc(location.origin)}/badge.svg" alt="Get it on pwamart" height="48"&gt;&lt;/a&gt;</div>
      <p class="muted" style="font-size:13px">Terminal: <code>npx -y @profullstack/pwamart install ${esc(app.slug)}</code> · iOS profile: <a href="/apps/${esc(app.slug)}/install.mobileconfig">/apps/${esc(app.slug)}/install.mobileconfig</a></p>
    </div>
    <p style="margin-top:30px"><button class="btn sm" id="remove">Remove this app</button></p>`;

  const act = (id, fn) => $(id)?.addEventListener('click', fn);
  const msg = (id, html) => ($(id).innerHTML = html);
  act('#verify', async () => {
    msg('#vmsg', '<span class="muted">Checking…</span>');
    try {
      const r = await api(`/apps/${slug}/verify`, { method: 'POST' });
      msg('#vmsg', `<span class="ok-msg">Verified by ${esc(r.method)}.</span>`);
      setTimeout(() => appDetail(slug), 600);
    } catch (err) {
      msg('#vmsg', errBox(err));
    }
  });
  act('#refresh', async () => {
    try {
      await api(`/apps/${slug}/refresh`, { method: 'POST' });
      appDetail(slug);
    } catch (err) {
      msg('#pmsg', errBox(err));
    }
  });
  for (const a of ['publish', 'unlist', 'unpublish'])
    act(`#${a}`, async () => {
      try {
        await api(`/apps/${slug}/${a}`, { method: 'POST' });
        appDetail(slug);
      } catch (err) {
        msg('#pmsg', errBox(err));
      }
    });
  act('#feature', async () => {
    await api(`/admin/apps/${slug}`, { method: 'POST', body: { featured: !app.featured } });
    appDetail(slug);
  });
  if (app.status === 'published') featuredPanel(slug);
  act('#staffverify', async () => {
    await api(`/admin/apps/${slug}`, { method: 'POST', body: { verified: true } });
    appDetail(slug);
  });
  act('#remove', async () => {
    if (!confirm(`Remove ${app.name} from pwamart? The slug stays reserved.`)) return;
    await api(`/apps/${slug}`, { method: 'DELETE' });
    await refreshMe();
    go('/console/apps');
  });
  $('#edit').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    try {
      await api(`/apps/${slug}`, { method: 'PATCH', body: { ...d, tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean) } });
      msg('#emsg', '<span class="ok-msg">Saved.</span>');
    } catch (err) {
      msg('#emsg', errBox(err));
    }
  });
}

/* ----------------------------------------------------------- publishers -- */

function publisherForm(orgs = []) {
  const shared = orgs.filter((o) => !o.personal && ['owner', 'admin'].includes(o.role));
  return `<form class="stack" id="pf">
    <label class="f">Name<input name="name" required maxlength="80" placeholder="Acme Apps"></label>
    <label class="f">Slug <small>pwamart.com/publishers/<b>slug</b>. Leave blank to derive it.</small><input name="slug" maxlength="50" pattern="[a-z0-9-]+"></label>
    <label class="f">Website<input name="website" type="url" placeholder="https://acme.example"></label>
    <label class="f">About<textarea name="bio" maxlength="1000" style="min-height:80px"></textarea></label>
    ${shared.length ? `<label class="f">Org<select name="org"><option value="">Personal</option>${shared.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select></label>` : ''}
    <div class="row"><button class="btn dark">Create publisher</button><span id="pmsg"></span></div>
  </form>`;
}
function bindPublisherForm(done) {
  $('#pf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const d = Object.fromEntries(new FormData(ev.target));
    Object.keys(d).forEach((k) => d[k] === '' && delete d[k]);
    try {
      await api('/publishers', { method: 'POST', body: d });
      await refreshMe();
      done();
    } catch (err) {
      $('#pmsg').innerHTML = errBox(err);
    }
  });
}

async function publishers() {
  const pl = me.plan;
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">${me.usage.publishers}${pl.publishers !== null ? ` of ${pl.publishers}` : ''} on ${esc(pl.name)}</div><h1>Publishers</h1></div></div>
    ${
      me.publishers.length
        ? `<div class="table-wrap" style="margin-bottom:28px"><table class="table"><thead><tr><th>Publisher</th><th>Org</th><th>Apps</th><th></th></tr></thead><tbody>
      ${me.publishers.map((p) => `<tr><td><b>${esc(p.name)}</b> ${p.verified ? '✓' : ''}<br><small class="muted">/publishers/${esc(p.slug)}</small></td><td>${esc(p.org_name)}</td><td>${p.apps}</td><td><a href="/publishers/${esc(p.slug)}" target="_blank">Public page ↗</a></td></tr>`).join('')}
    </tbody></table></div>`
        : ''
    }
    <h2 style="margin-bottom:12px">New publisher</h2>${publisherForm(me.orgs)}`;
  bindPublisherForm(() => publishers());
}

/* ----------------------------------------------------------------- orgs -- */

async function orgsPage() {
  const teams = me.plan.teams;
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">${teams ? 'Unlimited plan' : 'Unlimited plan feature'}</div><h1>Orgs &amp; teams</h1></div></div>
    <p class="muted" style="max-width:640px">Every account has a personal org. On Unlimited you can create shared orgs, invite people, split them into teams and group apps into projects.</p>
    <div class="table-wrap" style="margin:18px 0 28px"><table class="table"><thead><tr><th>Org</th><th>Your role</th><th></th></tr></thead><tbody>
      ${me.orgs.map((o) => `<tr><td><b>${esc(o.name)}</b>${o.personal ? ' <span class="pill">personal</span>' : ''}</td><td>${esc(o.role)}</td><td><a href="/console/orgs/${esc(o.slug)}">Open →</a></td></tr>`).join('')}
    </tbody></table></div>
    ${
      teams
        ? `<h2 style="margin-bottom:12px">New org</h2><form class="stack" id="of"><label class="f">Name<input name="name" required maxlength="80"></label><div class="row"><button class="btn dark">Create org</button><span id="omsg"></span></div></form>`
        : `<div class="panel"><h3>Work with a team</h3><p class="muted">Shared orgs, invites, teams and projects come with Unlimited: $199/year, unlimited publishers and apps.</p><a class="btn primary sm" href="/console/billing?plan=unlimited">Upgrade</a></div>`
    }`;
  $('#of')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const { org } = await api('/orgs', { method: 'POST', body: Object.fromEntries(new FormData(ev.target)) });
      await refreshMe();
      go(`/console/orgs/${org.slug}`);
    } catch (err) {
      $('#omsg').innerHTML = errBox(err);
    }
  });
}

async function orgDetail(ref) {
  const d = await api(`/orgs/${encodeURIComponent(ref)}`);
  const admin = ['owner', 'admin'].includes(me.orgs.find((o) => o.id === d.org.id)?.role);
  const box = (title, list, form) => `<div class="panel"><h3>${title}</h3>${list}${admin && form ? form : ''}</div>`;
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Org</div><h1>${esc(d.org.name)}</h1></div></div>
    <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      ${box('Members', `<ul>${d.members.map((m) => `<li>${esc(m.email)} <small class="muted">${esc(m.role)}</small></li>`).join('')}${d.invites.map((i) => `<li>${esc(i.email)} <small class="muted">invited · ${esc(i.role)}</small></li>`).join('')}</ul>`,
        `<form class="stack" data-f="invites"><label class="f">Invite by email<input name="email" type="email" required></label><label class="f">Role<select name="role"><option>member</option><option>admin</option></select></label><button class="btn sm dark">Send invite</button></form>`)}
      ${box('Teams', d.teams.length ? `<ul>${d.teams.map((t) => `<li>${esc(t.name)}</li>`).join('')}</ul>` : '<p class="muted">No teams yet.</p>',
        `<form class="stack" data-f="teams"><label class="f">New team<input name="name" required></label><button class="btn sm dark">Add team</button></form>`)}
      ${box('Projects', d.projects.length ? `<ul>${d.projects.map((p) => `<li>${esc(p.name)} <small class="muted">${p.apps} apps</small></li>`).join('')}</ul>` : '<p class="muted">No projects yet.</p>',
        `<form class="stack" data-f="projects"><label class="f">New project<input name="name" required></label><button class="btn sm dark">Add project</button></form>`)}
      ${box('Publishers', d.publishers.length ? `<ul>${d.publishers.map((p) => `<li>${esc(p.name)}</li>`).join('')}</ul>` : '<p class="muted">None yet. Create one under Publishers and pick this org.</p>')}
    </div><p id="omsg"></p>`;
  view.querySelectorAll('form[data-f]').forEach((f) =>
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api(`/orgs/${encodeURIComponent(ref)}/${f.dataset.f}`, { method: 'POST', body: Object.fromEntries(new FormData(f)) });
        orgDetail(ref);
      } catch (err) {
        $('#omsg').innerHTML = errBox(err);
      }
    }),
  );
}

/* -------------------------------------------------------------- billing -- */

async function billing() {
  const b = await api('/billing');
  const q = new URLSearchParams(location.search);
  const want = q.get('plan');
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
  const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
  const cur = b.plan.key;
  const RANK = { free: 0, pro: 1, unlimited: 2 };
  const name = { free: 'Free', pro: 'Pro', unlimited: 'Unlimited' };
  const upcoming = b.periods.filter((p) => !p.current);
  const statusLine = {
    staff: 'Staff account: unlimited, never billed.',
    free: 'You are on the free plan.',
    scheduled: `A paid plan starts ${day(b.periods[0]?.starts_at)}.`,
    active: `<b>${name[cur]}</b> is paid through <b>${day(b.plan.paid_through)}</b>${upcoming.length ? `, then ${upcoming.map((p) => `<b>${name[p.plan]}</b> through <b>${day(p.ends_at)}</b>`).join(', then ')}` : ''}. ${b.renew_plan && b.renew_plan !== cur && !upcoming.length ? `Switches to <b>${name[b.renew_plan]}</b> at renewal.` : 'We email a renewal link 14 and 3 days before the paid time ends.'}`,
    ending: `Cancelled: <b>${name[cur]}</b> ends <b>${day(b.coverage_end)}</b>, then the account is Free. Listings stay live.`,
  }[b.status];

  // What each plan card offers, given where the account is now.
  const action = (key) => {
    if (b.status === 'staff') return '';
    if (key === 'free') {
      if (cur === 'free') return '<button class="btn" disabled>Current plan</button>';
      if (b.status === 'ending') return '<button class="btn" disabled>Downgrade scheduled</button>';
      return '<button class="btn" data-act="cancel">Downgrade to Free (cancel)</button>';
    }
    const qt = b.quotes[key];
    if (key === cur) return `<button class="btn primary" data-buy="${key}">Renew · add a year · ${money(qt.amount_cents)}</button>`;
    if (RANK[key] > RANK[cur]) {
      const credit = qt.credit_cents ? ` <small>(${money(qt.credit_cents)} credit for unused Pro)</small>` : '';
      return `<button class="btn primary" data-buy="${key}">Upgrade now · ${money(qt.amount_cents)}</button>${credit}`;
    }
    // A lower paid plan while on a higher one: switch at renewal, optionally prepaid.
    const queued = upcoming.find((p) => p.plan === key);
    if (queued)
      return `<button class="btn" disabled>${name[key]} starts ${day(queued.starts_at)}</button>
        <button class="btn" data-buy="${key}">Prepay another year · ${money(qt.amount_cents)}</button>`;
    const switching = b.renew_plan === key;
    return `${switching ? '<button class="btn" disabled>Switches at renewal</button>' : `<button class="btn" data-renew="${key}">Switch to ${name[key]} at renewal</button>`}
      <button class="btn" data-buy="${key}">Prepay ${name[key]} from ${day(qt.starts_at)} · ${money(qt.amount_cents)}</button>`;
  };
  const limits = (key) => {
    const p = b.plans[key];
    const over = (n, lim) => lim !== null && n > lim;
    const warn = over(b.usage.publishers, p.publishers) || over(b.usage.apps, p.apps)
      ? `<p class="err" style="font-size:13px;margin:0">You have ${b.usage.publishers} publishers and ${b.usage.apps} apps. Everything stays listed, but you cannot add more past these limits.</p>`
      : '';
    return `<ul><li>${p.publishers ?? 'Unlimited'} publisher${p.publishers === 1 ? '' : 's'}</li><li>${p.apps ?? 'Unlimited'} apps</li>${p.teams ? '<li>Shared orgs, teams, projects</li>' : ''}</ul>${RANK[key] < RANK[cur] ? warn : ''}`;
  };
  const card = (key, price) => `<div class="plan ${key === cur ? 'hot current' : key === want ? 'hot wanted' : ''}">
      <div class="eyebrow">${name[key]}${key === cur ? ' · current' : ''}</div>
      <div class="price">${price}</div>
      ${limits(key)}
      <div style="display:grid;gap:8px;margin-top:auto">${action(key)}</div>
    </div>`;

  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Plan & billing</div><h1>${name[cur]}</h1></div>
      ${b.status === 'ending' ? '<button class="btn primary" data-act="resume">Resume plan</button>' : ''}</div>
    ${q.get('paid') ? '<p class="ok-msg">Payment sent. The plan changes when CoinPay confirms it on chain, usually within a few minutes; this page refreshes itself.</p>' : ''}
    <div class="panel" style="margin-bottom:18px">
      <p style="margin:0 0 10px">${statusLine}</p>
      <div class="kpis" style="margin:0">
        <div class="kpi"><span>Publishers</span><b>${b.usage.publishers}${b.plan.publishers !== null ? ` / ${b.plan.publishers}` : ''}</b>${meter(b.usage.publishers, b.plan.publishers)}</div>
        <div class="kpi"><span>Apps</span><b>${b.usage.apps}${b.plan.apps !== null ? ` / ${b.plan.apps}` : ''}</b>${meter(b.usage.apps, b.plan.apps)}</div>
      </div>
      <p class="muted" style="margin:10px 0 0;font-size:13px">Payment is prepaid crypto through CoinPay, so nothing is ever charged automatically. Upgrades apply at once with credit for unused Pro time; downgrades take effect when the paid time ends.</p>
    </div>
    <div class="plans">${card('free', '$0')}${card('pro', '$10<small> / year</small>')}${card('unlimited', '$199<small> / year</small>')}</div>
    <p id="bmsg"></p>
    ${b.payments.length ? `<h2 style="margin:10px 0 12px">Payments</h2><div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead><tbody>${b.payments.map((p) => `<tr><td>${esc(day(p.created_at))}</td><td>${esc(name[p.plan] ?? '')}</td><td>${money(p.amount_cents)}</td><td>${p.applied ? 'applied' : ['confirmed', 'paid', 'completed', 'settled', 'succeeded'].includes(p.status) ? 'not applied (underpaid)' : esc(p.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;

  const msg = (h) => ($('#bmsg').innerHTML = h);
  view.querySelectorAll('[data-buy]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        if (!b.payments_enabled) throw new Error('Payments are not switched on yet.');
        const { checkout_url } = await api('/billing/checkout', { method: 'POST', body: { plan: btn.dataset.buy } });
        location.assign(checkout_url);
      } catch (err) {
        msg(errBox(err));
      }
    }),
  );
  const post = async (path, body, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api(path, { method: 'POST', body });
      await refreshMe();
      billing();
    } catch (err) {
      msg(errBox(err));
    }
  };
  view.querySelectorAll('[data-renew]').forEach((btn) =>
    btn.addEventListener('click', () => post('/billing/renewal', { renew: btn.dataset.renew }, `Switch to ${name[btn.dataset.renew]} when ${name[cur]} ends on ${day(b.coverage_end)}?`)),
  );
  view.querySelector('[data-act="cancel"]')?.addEventListener('click', () =>
    post('/billing/cancel', {}, `Cancel ${name[cur]}? It stays active until ${day(b.coverage_end)}, then the account is Free. Nothing is refunded; listings stay live.`),
  );
  view.querySelector('[data-act="resume"]')?.addEventListener('click', () => post('/billing/resume', {}));

  // Back from checkout: poll until the webhook lands (every 15s, then 30s), so the new plan appears on its own.
  if (q.get('paid') && !billing.polling) {
    const before = JSON.stringify(b.periods);
    const started = Date.now();
    billing.polling = true;
    const poll = async () => {
      if (location.pathname !== '/console/billing') return (billing.polling = false);
      const now = await api('/billing').catch(() => null);
      if (now && JSON.stringify(now.periods) !== before) {
        billing.polling = false;
        history.replaceState({}, '', '/console/billing');
        await refreshMe();
        return billing();
      }
      setTimeout(poll, Date.now() - started < 10 * 60_000 ? 15_000 : 30_000);
    };
    setTimeout(poll, 15_000);
  }
}

/* ---------------------------------------------------------------- claims -- */

async function claimView(slug) {
  let claim;
  try {
    claim = (await api(`/publishers/${encodeURIComponent(slug)}/claim`, { method: 'POST' })).claim;
  } catch (err) {
    view.innerHTML = `<div class="page-head"><h1>Claim a listing</h1></div>${errBox(err)}<p><a href="/publishers/${esc(slug)}">Back to the publisher</a></p>`;
    return;
  }
  const render = () => {
    const r = claim.record;
    const state = {
      pending: `<span class="pill unlisted">waiting for DNS</span> <span class="muted">Checking every ${claim.interval_seconds} seconds${claim.checks ? ` · ${claim.checks} checks so far` : ''}${claim.last_result ? ` · last: ${esc(claim.last_result)}` : ''}</span>`,
      verified: '<span class="pill published">verified</span> It is yours.',
      expired: '<span class="pill">expired</span> No record turned up in 7 days. Start again to get a new token.',
      superseded: '<span class="pill">closed</span> Someone else proved the domain first.',
    }[claim.status];
    view.innerHTML = `<div class="page-head"><div><div class="eyebrow">Claim a listing</div><h1>${esc(claim.publisher?.name ?? slug)}</h1></div></div>
      <div class="panel" style="margin-bottom:18px">
        <h3>Prove you run ${esc(claim.domain)}</h3>
        <p class="muted">Add this DNS record where ${esc(claim.domain)} is hosted (Cloudflare, Porkbun, Route 53, ...). Leave this page open or come back later: we keep checking until it shows up.</p>
        <div class="snip"><div class="snip-head"><span>Type</span></div><pre><code>${esc(r.type)}</code></pre></div>
        <div class="snip"><div class="snip-head"><span>Name / host</span><button class="btn sm" type="button" data-copy="${esc(r.name)}">Copy</button></div><pre><code>${esc(r.name)}</code></pre></div>
        <div class="snip"><div class="snip-head"><span>Value</span><button class="btn sm" type="button" data-copy="${esc(r.value)}">Copy</button></div><pre><code>${esc(r.value)}</code></pre></div>
        <p style="margin:16px 0 0" id="claim-state">${state}</p>
        <div class="row" style="margin-top:14px">
          ${claim.status === 'pending' ? '<button class="btn dark" id="check-now">Check now</button>' : ''}
          ${claim.status === 'verified' ? '<a class="btn primary" href="/console/publishers">Go to your publishers</a>' : ''}
        </div>
        <p class="muted" style="font-size:13px;margin:12px 0 0">Some DNS hosts want only <code>_pwamart</code> in the name field and add the domain themselves. New records usually appear within a few minutes.</p>
      </div>`;
    view.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', async () => {
        await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1400);
      }),
    );
    view.querySelector('#check-now')?.addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      claim = (await api(`/claims/${claim.id}/check`, { method: 'POST' })).claim;
      render();
    });
  };
  render();
  // The daemon does the checking; this just follows along at the same pace.
  const follow = async () => {
    if (!location.pathname.startsWith('/console/claim/') || claim.status !== 'pending') return;
    claim = (await api(`/claims/${claim.id}`).catch(() => ({ claim }))).claim;
    if (claim.status !== 'pending') await refreshMe().catch(() => {});
    render();
    setTimeout(follow, claim.interval_seconds * 1000);
  };
  setTimeout(follow, claim.interval_seconds * 1000);
}

/* ----------------------------------------------------------------- keys -- */

async function keys() {
  const { keys: list } = await api('/keys');
  view.innerHTML = `<div class="page-head"><h1>API keys &amp; passkeys</h1></div>
    <div class="panel" style="margin-bottom:22px"><h3>Passkeys</h3><p class="muted">${me.user.passkeys ? `You have ${me.user.passkeys} saved.` : 'Sign in with Face ID, Touch ID or a security key next time.'}</p><button class="btn sm dark" id="addpk">Add a passkey</button> <span id="kmsg"></span></div>
    <h2 style="margin-bottom:6px">API keys</h2>
    <p class="muted">For the CLI (<code>pwamart login</code>), the TUI, the desktop app, MCP (<code>PWAMART_API_KEY</code>) and your own scripts.</p>
    <form class="row" id="kf" style="margin:12px 0 18px"><input class="f" name="name" placeholder="Key name, e.g. laptop" style="padding:10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)"><button class="btn dark sm">Create key</button></form>
    <div id="newkey"></div>
    ${list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th></th></tr></thead><tbody>${list.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.prefix)}…</code></td><td>${k.last_used_at ? esc(k.last_used_at.slice(0, 10)) : 'never'}</td><td><button class="btn sm" data-revoke="${esc(k.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $('#kf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const k = await api('/keys', { method: 'POST', body: { name: new FormData(ev.target).get('name') || 'default' } });
    $('#newkey').innerHTML = `<div class="panel" style="margin-bottom:18px"><b>Copy it now; it is shown once.</b><div class="code-block" style="margin-top:8px">${esc(k.key)}</div><p class="muted" style="font-size:13px">pwamart login ${esc(k.key)}</p></div>`;
  });
  view.querySelectorAll('[data-revoke]').forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/keys/${b.dataset.revoke}`, { method: 'DELETE' });
      keys();
    }),
  );
  $('#addpk').addEventListener('click', async () => {
    try {
      if (!window.SimpleWebAuthnBrowser) throw new Error('Passkeys are not available in this browser');
      const { options, challengeId } = await api('/auth/passkey/register/options', { method: 'POST' });
      const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
      await api('/auth/passkey/register/verify', { method: 'POST', body: { response, challengeId } });
      await refreshMe();
      keys();
    } catch (err) {
      $('#kmsg').innerHTML = errBox(err);
    }
  });
}

route();

/* -------------------------------------------------------------- featured -- */

const day = (d) => new Date(d).toISOString().slice(0, 10);

/** Get featured for $19: a week on the home page plus the next newsletter. Paid in crypto. */
async function featuredPanel(slug) {
  const box = $('#featured-panel');
  if (!box) return;
  const paid = new URLSearchParams(location.search).get('featured') === '1';
  let st;
  try {
    st = await api(`/apps/${encodeURIComponent(slug)}/featured`);
  } catch (err) {
    box.innerHTML = errBox(err);
    return;
  }
  const price = `$${st.price_cents / 100}`;
  const now = st.featured
    ? `<p class="ok-msg">Featured${st.featured_until ? ` until ${esc(day(st.featured_until))}` : ' (staff pick)'}.${st.newsletter_owed ? ' In the next newsletter issue.' : ''}</p>`
    : st.newsletter_owed
      ? '<p class="ok-msg">In the next newsletter issue.</p>'
      : '';
  box.innerHTML = `<div class="row" style="justify-content:space-between"><h3>Get featured · ${esc(price)}</h3><a class="btn sm" href="/featured" target="_blank">How it works ↗</a></div>
    <p class="muted">${esc(st.days)} days on the home page's Featured row and at the top of the store, plus a slot in the next pwamart newsletter. One payment in crypto through CoinPay${st.featured && st.featured_until ? '; buying again adds the time on' : ''}.</p>
    ${now}
    <div class="row"><button class="btn primary" id="buy-feature" ${st.payments_enabled ? '' : 'disabled'}>${st.featured ? 'Add 7 more days' : `Feature it for ${esc(price)}`}</button><span id="fmsg"></span></div>`;
  $('#buy-feature').addEventListener('click', async () => {
    $('#buy-feature').disabled = true;
    $('#fmsg').innerHTML = '<span class="muted">Opening CoinPay…</span>';
    try {
      const r = await api(`/apps/${encodeURIComponent(slug)}/feature`, { method: 'POST' });
      location.assign(r.checkout_url);
    } catch (err) {
      $('#fmsg').innerHTML = errBox(err);
      $('#buy-feature').disabled = false;
    }
  });
  // Back from CoinPay: wait for the webhook to land, the same way billing does.
  if (paid && !st.featured && !st.newsletter_owed) {
    $('#fmsg').innerHTML = '<span class="muted">Waiting for the payment to settle…</span>';
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const again = await api(`/apps/${encodeURIComponent(slug)}/featured`).catch(() => null);
      if (again && (again.featured || again.newsletter_owed)) {
        history.replaceState({}, '', `/console/apps/${slug}`);
        return featuredPanel(slug);
      }
    }
    $('#fmsg').innerHTML = '<span class="muted">Still waiting on CoinPay. This page updates when the payment settles; reload in a minute.</span>';
  }
}

/** /console/feature: pick which of your live apps to feature. */
async function featurePick() {
  const { apps } = await api('/me/apps');
  const live = apps.filter((a) => a.status === 'published');
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">$19 · 7 days + the newsletter</div><h1>Get featured</h1></div></div>
    <p class="muted">Pick a live app. You pay once in crypto through CoinPay, and it goes on the home page's Featured row and into the next newsletter as soon as the payment settles.</p>
    ${
      live.length
        ? `<div class="stack">${live
            .map(
              (a) => `<div class="panel row" style="justify-content:space-between"><div class="row">${a.icon ? `<img class="icon" src="${esc(a.icon)}" width="40" height="40" alt="" referrerpolicy="no-referrer">` : ''}<b>${esc(a.name)}</b>${a.featured ? ' <span class="pill published">featured</span>' : ''}</div>
              <a class="btn primary sm" href="/console/apps/${esc(a.slug)}#featured-panel">Feature it</a></div>`,
            )
            .join('')}</div>`
        : '<p>No live apps yet. <a href="/console/submit">List one</a>, publish it, then come back.</p>'
    }`;
}
