/**
 * The pwamart API, as function calls. Shared by the CLI, the TUI, the desktop
 * app and the stdio MCP server. Plain fetch, no dependencies: Node 20+ or Bun.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createTokenStore, getAccessToken } from '@profullstack/auth-system/cli';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pwamart', 'config.json');

export async function loadConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

/** Server and key: flags and environment first, then the saved config. */
/** The OAuth 2.1 sign-in `pwamart login` saves; shared by the CLI, TUI and stdio MCP. */
export const tokenStore = () => createTokenStore('pwamart');

/**
 * Server and credential, first match wins: --key / PWAMART_API_KEY / a saved API
 * key, then the OAuth sign-in from `pwamart login` (refreshed here when it is
 * about to expire). Anonymous when there is neither; reads still work.
 */
export async function resolveAuth({ server, key } = {}) {
  const saved = await loadConfig();
  const srv = (server || process.env.PWAMART_URL || saved.server || 'https://pwamart.com').replace(/\/+$/, '');
  let k = key || process.env.PWAMART_API_KEY || saved.key || '';
  let via = k ? 'api-key' : 'anonymous';
  if (!k) {
    const store = tokenStore();
    const t = await store.load();
    if (t?.issuer && t.issuer.replace(/\/+$/, '') === srv) {
      k = (await getAccessToken({ store })) || '';
      if (k) via = 'oauth';
    }
  }
  return { server: srv, key: k, via };
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ? `${body.error} (HTTP ${status})` : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function call(auth, path, init = {}) {
  const res = await fetch(`${auth.server}/api/v1${path}`, {
    ...init,
    headers: {
      'user-agent': 'pwamart-cli',
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof body === 'string' ? { error: body.slice(0, 200) } : body);
  return body;
}

const post = (body) => ({ method: 'POST', body: JSON.stringify(body ?? {}) });
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();

export const health = (auth) => call(auth, '/health');
export const search = (auth, { q, category, sort, limit = 20, offset } = {}) => call(auth, `/apps?${qs({ q, category, sort, limit, offset })}`);
export const getApp = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}`);
export const categories = (auth) => call(auth, '/categories');
export const countInstall = (auth, slug, method) => call(auth, `/apps/${encodeURIComponent(slug)}/installs`, post({ method }));
export const me = (auth) => call(auth, '/me');
export const myApps = (auth) => call(auth, '/me/apps');
export const submit = (auth, body) => call(auth, '/apps', post(body));
export const verify = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/verify`, post());
export const publish = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/publish`, post());
export const featured = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/featured`);
export const feature = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/feature`, post());
export const subscribe = (auth, email) => call(auth, '/newsletter/subscribe', post({ email, source: 'cli' }));
export const releases = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/releases`);
export const postRelease = (auth, slug, body) => call(auth, `/apps/${encodeURIComponent(slug)}/releases`, post(body));
export const follow = (auth, body) => call(auth, '/follow', post(body));
export const follows = (auth) => call(auth, '/me/follows');
export const unfollow = (auth, id) => call(auth, `/follows/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const refresh = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/refresh`, post());
export const manage = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/manage`);
export const createPublisher = (auth, body) => call(auth, '/publishers', post(body));
const pub = (slug) => `/publishers/${encodeURIComponent(slug)}`;
export const managePublisher = (auth, slug) => call(auth, `${pub(slug)}/manage`);
export const updatePublisher = (auth, slug, body) => call(auth, pub(slug), { method: 'PATCH', body: JSON.stringify(body) });
export const verifyPublisher = (auth, slug) => call(auth, `${pub(slug)}/verify`, post());
export const autofillPublisher = (auth, slug, url) => call(auth, `${pub(slug)}/autofill`, post(url ? { url } : {}));
export const inspect = (auth, url) => call(auth, '/inspect', post({ url }));
