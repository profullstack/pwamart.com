/**
 * The pwamart API, as function calls. Shared by the CLI, the TUI, the desktop
 * app and the stdio MCP server. Plain fetch, no dependencies: Node 20+ or Bun.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
export async function resolveAuth({ server, key } = {}) {
  const saved = await loadConfig();
  return {
    server: (server || process.env.PWAMART_URL || saved.server || 'https://pwamart.com').replace(/\/+$/, ''),
    key: key || process.env.PWAMART_API_KEY || saved.key || '',
  };
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
export const refresh = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/refresh`, post());
export const manage = (auth, slug) => call(auth, `/apps/${encodeURIComponent(slug)}/manage`);
export const createPublisher = (auth, body) => call(auth, '/publishers', post(body));
export const inspect = (auth, url) => call(auth, '/inspect', post({ url }));
