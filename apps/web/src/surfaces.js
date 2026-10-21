import { safeFetch } from './inspect.js';

/**
 * Every listing is a PWA. Some are also a CLI, an HTTP API, an MCP server or a
 * native desktop app, and an agent can use the first three without a browser at
 * all. This finds them:
 *
 *   cli  a `curl | sh` installer: the app's own /install.sh (a shell script, by its
 *        shebang), or its entry in the w3bs package catalog (w3bs.org/packages)
 *   mcp  a streamable-HTTP MCP server that answers `initialize`, at /mcp, /api/mcp
 *        or a same-host MCP URL its llms.txt names; plus an `npx` stdio command
 *        when llms.txt gives one
 *   api  an OpenAPI document, a JSON /api/v1/health, or /api/ paths in llms.txt
 *   desktop  the downloads under a "Desktop" heading in llms.txt (same host, or the
 *        app's GitHub releases); failing that, installer links (.dmg, .exe, …)
 *
 * Only the app's own origin is probed (through the inspector's guarded fetch), and
 * only the publisher's own words (its origin, its w3bs entry) become a command we
 * show. A publisher can correct any of it: `surfaces_set` wins key by key.
 */

export const SURFACES = { pwa: 'PWA', cli: 'CLI', api: 'API', mcp: 'MCP', desktop: 'Desktop' };
/** The surfaces besides pwa, which every listing is. */
export const EXTRA_SURFACES = Object.keys(SURFACES).filter((k) => k !== 'pwa');
export const surfaceKey = (v) => (v && Object.hasOwn(SURFACES, String(v)) ? String(v) : null);

export const W3BS_CATALOG = 'https://w3bs.org/repo/targets/catalog/index.json';
export const w3bsPage = (entry) => `https://w3bs.org/packages?q=${encodeURIComponent(entry.split('/').pop())}#${encodeURIComponent(entry)}`;

const bareHost = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/* ----------------------------------------------------------- w3bs catalog -- */

let cache = { at: 0, entries: null };
/** The w3bs package catalog, cached an hour. A fixed, trusted URL; on failure the last copy (or none). */
export async function w3bsCatalog({ fetchFn = fetch, maxAgeMs = 60 * 60_000 } = {}) {
  if (cache.entries && Date.now() - cache.at < maxAgeMs) return cache.entries;
  try {
    const res = await fetchFn(W3BS_CATALOG, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    cache = { at: Date.now(), entries: Array.isArray(d?.entries) ? d.entries : [] };
  } catch (err) {
    console.error(`[surfaces] w3bs catalog: ${err.message}`);
    cache.at = Date.now();
    cache.entries ??= [];
  }
  return cache.entries;
}

/**
 * The catalog entry for an app on this host (its homepage host or its id's host,
 * `host/name`). One host can carry several tools (w3bs.org has two, neither of them
 * the w3bs CLI), so with more than one the entry named after the host or the app
 * wins, and with none of those named it is left to the origin's own installer.
 */
export function w3bsMatch(entries, origin, slug = null) {
  const host = bareHost(origin);
  if (!host) return null;
  const idHost = (x) => String(x.id ?? '').split('/')[0].toLowerCase().replace(/^www\./, '');
  const found = entries.filter((x) => bareHost(x.homepage) === host || idHost(x) === host);
  if (found.length <= 1) return found[0] ?? null;
  const names = new Set([host.split('.')[0], slug].filter(Boolean).map((n) => n.toLowerCase()));
  return found.find((x) => names.has(String(x.id).split('/').pop().toLowerCase()) || names.has(String(x.name ?? '').toLowerCase())) ?? null;
}

/* --------------------------------------------------------------- commands -- */

const SHELLS = new Set(['sh', 'bash']);
export const curlLine = (url, shell = 'sh') => `curl -fsSL ${url} | ${SHELLS.has(shell) ? shell : 'sh'}`;
const shellOf = (script) => (/^#!\s*(\/usr\/bin\/env\s+bash|\/bin\/bash|\/usr\/bin\/bash)\b/.test(script) ? 'bash' : 'sh');

const httpsUrl = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};
const NPX = /^npx -y (@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*( [\w.@/:=-]+){0,4}$/;
const W3BS_ID = /^[a-z0-9.-]+\.[a-z]{2,}\/[a-z0-9][\w.-]*$/i;

/* ---------------------------------------------------------------- desktop -- */

const DESKTOP_MAX = 12;
const INSTALLER = /\.(dmg|exe|msi|appimage|deb|rpm)$/i;
const INSTALLER_LABEL = { dmg: 'macOS', exe: 'Windows', msi: 'Windows', appimage: 'Linux AppImage', deb: 'Debian/Ubuntu .deb', rpm: 'Fedora/RHEL .rpm' };
const LINK = /https:\/\/[^\s)<>"'`\]]+/g;
const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
/** A GitHub release page or asset: github.com/<owner>/<repo>/releases… */
const ghRelease = (u) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases(\/|$)/i.test(u);
const ghReleasesPage = (u) => u.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases/i)?.[0] ?? null;
const cleanLabel = (v) => String(v ?? '').replace(/[\s\x00-\x1f]+/g, ' ').trim().slice(0, 80);

/**
 * The desktop app an origin's own llms.txt says it ships, or null:
 *
 *   ## Desktop app
 *   Downloads: https://your.app/download
 *   - macOS (Apple silicon): https://your.app/download/mac-arm64
 *   - Windows (x64): https://github.com/you/app/releases/download/v1/App-Setup.exe
 *
 * Links count only on the app's own host or its GitHub releases. A list line is a
 * download, labelled by its text before the link; `page` is the section's
 * /download(s) link, or its first link. Without such a section, installer links
 * (.dmg, .exe, .msi, .AppImage, .deb, .rpm) anywhere in the file are used.
 */
export function desktopFrom(notes, origin) {
  const host = bareHost(origin);
  if (!host || !notes) return null;
  const accept = (raw) => {
    const url = httpsUrl(String(raw).replace(/[.,;:]+$/, ''));
    return url && (bareHost(url) === host || ghRelease(url)) ? url : null;
  };
  const isPage = (u) => bareHost(u) === host && /^\/downloads?\/?$/i.test(new URL(u).pathname);
  const lines = String(notes).split('\n');
  const start = lines.findIndex((l) => HEADING.test(l) && /desktop/i.test(l));
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && HEADING.test(l));
    const links = [];
    const downloads = [];
    for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
      for (const m of line.matchAll(LINK)) {
        const url = accept(m[0]);
        if (!url) continue;
        links.push(url);
        if (!LIST_ITEM.test(line) || isPage(url)) continue;
        // "- macOS (Apple silicon): https://…" or "- [macOS](https://…)"
        const text = line.slice(0, m.index).replace(LIST_ITEM, '');
        const label = cleanLabel(text.match(/\[([^\]]+)\]\($/)?.[1] ?? text.replace(/[\s:–—-]+$/, '')) || cleanLabel(new URL(url).pathname.split('/').pop());
        if (!downloads.some((d) => d.url === url)) downloads.push({ label, url });
      }
    }
    if (links.length) return { page: links.find(isPage) ?? links[0], downloads: downloads.slice(0, DESKTOP_MAX), source: 'detected' };
  }
  const files = [...new Set([...String(notes).matchAll(LINK)].map((m) => accept(m[0])).filter((u) => u && INSTALLER.test(new URL(u).pathname)))];
  if (!files.length) return null;
  const downloads = files.slice(0, DESKTOP_MAX).map((url) => {
    const ext = new URL(url).pathname.match(INSTALLER)[1].toLowerCase();
    return { label: `${INSTALLER_LABEL[ext]}${ext === 'msi' ? ' .msi' : ''}`, url };
  });
  return { page: files.map(ghReleasesPage).find(Boolean) ?? null, downloads, source: 'detected' };
}

/* -------------------------------------------------------------- detection -- */

const ok = (r) => r && r.status >= 200 && r.status < 300;
const isHtml = (r) => /html/i.test(r.type ?? '') || /^\s*<(!doctype|html)/i.test(r.text ?? '');

/** The first JSON-RPC message in a JSON or SSE body. */
export function rpcMessage(text) {
  const t = String(text ?? '').trim();
  const tryJson = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  if (t.startsWith('{')) return tryJson(t);
  for (const line of t.split('\n')) if (line.startsWith('data:')) return tryJson(line.slice(5).trim());
  return null;
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pwamart-inspector', version: '1.0' } },
});

/** { name } when `url` answers initialize; { name: null, auth: true } when a named endpoint wants a key first. */
async function probeMcp(url, fetchFn, { named = false } = {}) {
  try {
    const r = await fetchFn(url, {
      method: 'POST',
      body: INIT,
      headers: { 'content-type': 'application/json' },
      accept: 'application/json, text/event-stream',
      maxBytes: 256 * 1024,
      timeoutMs: 8_000,
    });
    // An endpoint the app's own llms.txt calls MCP that answers 401/403 in JSON is an
    // MCP server behind a key. Guessed paths need a real answer: plenty of sites 401
    // every /api/ path they do not know.
    if (named && r && (r.status === 401 || r.status === 403) && !isHtml(r)) return { name: null, auth: true };
    if (!ok(r)) return null;
    const m = rpcMessage(r.text);
    return m?.result?.protocolVersion || m?.result?.serverInfo ? { name: m.result.serverInfo?.name ?? null } : null;
  } catch {
    return null;
  }
}

const get = async (fetchFn, url, opts = {}) => {
  try {
    return await fetchFn(url, { maxBytes: 512 * 1024, timeoutMs: 8_000, ...opts });
  } catch {
    return null;
  }
};

/**
 * Probe one origin. `fetchFn` is the inspector's safeFetch (tests pass a fake);
 * `catalog` is the w3bs catalog (w3bsCatalog()). Returns { cli, api, mcp, desktop }, each
 * null or a plain object that says where it came from.
 */
export async function detectSurfaces({ origin, fetchFn = safeFetch, catalog = [], slug = null }) {
  const base = String(origin).replace(/\/+$/, '');
  const host = bareHost(base);
  const sameHost = (u) => bareHost(u) === host;
  const out = { cli: null, api: null, mcp: null, desktop: null };

  const [script, llms] = await Promise.all([get(fetchFn, `${base}/install.sh`, { accept: 'text/plain, */*' }), get(fetchFn, `${base}/llms.txt`, { accept: 'text/plain, */*' })]);
  const notes = ok(llms) && !isHtml(llms) ? llms.text : '';

  /* cli */
  const entry = w3bsMatch(catalog, base, slug);
  const entryUrl = httpsUrl(entry?.install?.url);
  if (entry && entryUrl) {
    out.cli = {
      install: curlLine(entryUrl, entry.install.shell),
      script: entryUrl,
      w3bs: W3BS_ID.test(entry.id ?? '') ? entry.id : null,
      commands: (entry.commands ?? []).filter((c) => typeof c === 'string').slice(0, 8),
      source: 'w3bs',
    };
  } else if (ok(script) && script.text.startsWith('#!') && !isHtml(script)) {
    out.cli = { install: curlLine(`${base}/install.sh`, shellOf(script.text)), script: `${base}/install.sh`, w3bs: null, commands: [], source: 'detected' };
  }

  /* mcp */
  const named = [...notes.matchAll(/https:\/\/[^\s)<>"'`]*mcp[^\s)<>"'`]*/gi)].map((m) => m[0].replace(/[.,;]+$/, '')).filter(sameHost);
  for (const url of [...new Set([`${base}/mcp`, `${base}/api/mcp`, ...named])].slice(0, 4)) {
    const m = await probeMcp(url, fetchFn, { named: named.includes(url) });
    if (m) {
      out.mcp = { url, transport: 'http', name: m.name, stdio: null, ...(m.auth && { auth: true }), source: 'detected' };
      break;
    }
  }
  const stdio = notes.match(/npx -y (@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*mcp[\w.-]*( mcp)?\b/i)?.[0] ?? notes.match(/npx -y (@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]* mcp\b/i)?.[0];
  if (stdio && NPX.test(stdio)) out.mcp = out.mcp ? { ...out.mcp, stdio } : { url: null, transport: 'stdio', name: null, stdio, source: 'detected' };

  /* api */
  let openapi = null;
  const linked = [...notes.matchAll(/https:\/\/[^\s)<>"'`]*openapi[^\s)<>"'`]*\.(json|ya?ml)/gi)].map((m) => m[0]).filter(sameHost);
  for (const url of [...new Set([...linked, `${base}/openapi.json`, `${base}/api/openapi.json`])].slice(0, 3)) {
    const r = await get(fetchFn, url, { accept: 'application/json, application/yaml, */*' });
    if (ok(r) && !isHtml(r) && /["']?(openapi|swagger)["']?\s*:/.test(r.text.slice(0, 2000))) {
      openapi = url;
      break;
    }
  }
  const health = await get(fetchFn, `${base}/api/v1/health`, { accept: 'application/json' });
  const healthy = ok(health) && !isHtml(health) && health.text.trim().startsWith('{');
  const apiPaths = /(^|[\s`(])(GET|POST|PUT|PATCH|DELETE)\s+\/api\//m.test(notes) || notes.includes(`${host}/api/`);
  if (openapi || healthy || apiPaths) {
    out.api = {
      base: healthy || /\/api\/v1\//.test(notes) ? `${base}/api/v1` : `${base}/api`,
      openapi,
      docs: openapi ?? (notes ? `${base}/llms.txt` : null),
      source: 'detected',
    };
  }

  /* desktop */
  out.desktop = desktopFrom(notes, base);
  return out;
}

/* ------------------------------------------------- publisher's corrections -- */

/**
 * Clean what a publisher sent for `surfaces`. Each key is an object (merged over
 * what was detected), false (hide it) or null (back to detection). Throws a
 * message for the API to return.
 */
export function cleanSurfaceSet(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('surfaces must be an object of cli, api, mcp and desktop');
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!EXTRA_SURFACES.includes(k)) throw new Error(`unknown surface ${k}; use cli, api, mcp or desktop`);
    if (v === null || v === false) {
      out[k] = v;
      continue;
    }
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`surfaces.${k} must be an object, false or null`);
    if (k === 'cli') {
      const url = httpsUrl(v.script ?? String(v.install ?? '').match(/^curl -fsSL (\S+) \| (sh|bash)$/)?.[1]);
      const w3bs = v.w3bs ? String(v.w3bs) : null;
      if (!url && !w3bs) throw new Error('surfaces.cli needs script (an https URL of a shell installer) or install ("curl -fsSL https://… | sh")');
      if (w3bs && !W3BS_ID.test(w3bs)) throw new Error('surfaces.cli.w3bs is a w3bs package id, like example.com/tool');
      const shell = String(v.install ?? '').endsWith('| bash') || v.shell === 'bash' ? 'bash' : 'sh';
      out.cli = {
        ...(url && { install: curlLine(url, shell), script: url }),
        w3bs,
        commands: Array.isArray(v.commands) ? v.commands.map(String).filter((c) => /^[\w.-]{1,40}$/.test(c)).slice(0, 8) : [],
        source: 'publisher',
      };
    } else if (k === 'mcp') {
      const url = v.url ? httpsUrl(v.url) : null;
      if (v.url && !url) throw new Error('surfaces.mcp.url must be https');
      const stdio = v.stdio ? String(v.stdio).trim() : null;
      if (stdio && !NPX.test(stdio)) throw new Error('surfaces.mcp.stdio must be an "npx -y <package> [args]" command');
      if (!url && !stdio) throw new Error('surfaces.mcp needs url (streamable HTTP) or stdio (npx -y …)');
      out.mcp = { url, transport: url ? 'http' : 'stdio', name: null, stdio, source: 'publisher' };
    } else if (k === 'desktop') {
      const page = v.page ? httpsUrl(v.page) : null;
      if (v.page && !page) throw new Error('surfaces.desktop.page must be an https URL');
      if (v.downloads !== undefined && !Array.isArray(v.downloads)) throw new Error('surfaces.desktop.downloads is a list of {label, url}');
      const downloads = (v.downloads ?? []).slice(0, DESKTOP_MAX).map((d) => {
        const url = httpsUrl(d?.url);
        if (!url) throw new Error('each surfaces.desktop.downloads[].url must be an https URL');
        return { label: cleanLabel(d.label) || cleanLabel(new URL(url).pathname.split('/').pop()), url };
      });
      if (!page && !downloads.length) throw new Error('surfaces.desktop needs page (an https downloads page) or downloads ([{label, url}])');
      out.desktop = { page, downloads, source: 'publisher' };
    } else {
      const base = httpsUrl(v.base);
      const docs = v.docs ? httpsUrl(v.docs) : null;
      const openapi = v.openapi ? httpsUrl(v.openapi) : null;
      if (!base) throw new Error('surfaces.api.base must be an https URL');
      if ((v.docs && !docs) || (v.openapi && !openapi)) throw new Error('surfaces.api.docs and openapi must be https URLs');
      out.api = { base: base.replace(/\/+$/, ''), openapi, docs: docs ?? openapi, source: 'publisher' };
    }
  }
  return out;
}

/** Detected, then the publisher's word on top. `pwa` is always there: it is a PWA store. */
export function mergeSurfaces(detected = {}, set = {}) {
  const out = { pwa: true };
  for (const k of EXTRA_SURFACES) {
    const s = set?.[k];
    out[k] = s === false ? null : s ? { ...(detected?.[k] ?? {}), ...s } : (detected?.[k] ?? null);
  }
  return out;
}

export const keysOf = (merged) => Object.keys(SURFACES).filter((k) => merged[k]);
