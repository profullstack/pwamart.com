/**
 * Installing a web app from a terminal.
 *
 * A browser installs a PWA through its own UI; nothing outside it can press that
 * button. What a terminal can do is the same thing the browser's install produces:
 * open the URL as a standalone app window (Chromium's --app mode) and, on Linux,
 * write a freedesktop launcher entry with the app's icon, so it shows in the menu
 * and dock like any other app.
 *
 * Browser order: TronBrowser (`tron --app=`, so the launcher's extensions, GPU mode
 * and profile apply), then Chrome, Chromium, Edge, Brave. PWAMART_BROWSER overrides.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const which = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [cmd] : ['-v', cmd], {
    shell: process.platform !== 'win32',
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
};

const MAC_APPS = [
  ['TronBrowser', '/Applications/TronBrowser.app/Contents/MacOS/TronBrowser'],
  ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave Browser', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
];
const WIN_APPS = [
  ['Chrome', join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe')],
  ['Chrome', join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe')],
  ['Edge', join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')],
  ['Brave', join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')],
];

/** { name, bin, tron } for the browser that will host the app window, or null. */
export function findBrowser(env = process.env) {
  if (env.PWAMART_BROWSER) return { name: env.PWAMART_BROWSER, bin: env.PWAMART_BROWSER, tron: /tron/.test(env.PWAMART_BROWSER) };
  const tron = which('tron');
  if (tron) return { name: 'TronBrowser', bin: tron, tron: true };
  if (platform() === 'darwin') {
    const hit = MAC_APPS.find(([, p]) => existsSync(p));
    return hit ? { name: hit[0], bin: hit[1], tron: hit[0] === 'TronBrowser' } : null;
  }
  if (platform() === 'win32') {
    const hit = WIN_APPS.find(([, p]) => existsSync(p));
    return hit ? { name: hit[0], bin: hit[1], tron: false } : null;
  }
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser', 'brave']) {
    const bin = which(cmd);
    if (bin) return { name: cmd, bin, tron: false };
  }
  return null;
}

export function appArgs(url, slug) {
  return [`--app=${url}`, `--class=pwamart-${slug}`];
}

/** The freedesktop entry: what makes it an "installed app" in the Linux menu. */
export function desktopEntry({ name, slug, url, bin, iconPath, summary }) {
  const q = (s) => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${String(name).replace(/[\r\n]/g, ' ')}`,
    summary ? `Comment=${String(summary).replace(/[\r\n]/g, ' ')}` : null,
    `Exec=${q(bin)} ${appArgs(url, slug).map(q).join(' ')}`,
    iconPath ? `Icon=${iconPath}` : 'Icon=applications-internet',
    'Terminal=false',
    'Categories=Network;WebBrowser;',
    `StartupWMClass=pwamart-${slug}`,
    `X-Pwamart-Slug=${slug}`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

async function saveIcon(url, slug) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('svg') ? 'svg' : type.includes('png') ? 'png' : type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
    const dir = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'pwamart', 'icons');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${slug}.${ext}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch {
    return null;
  }
}

/**
 * Install `app` (the API's app shape). Returns what it did, so the CLI, TUI and
 * desktop app can each report it their own way. `launch: false` only writes the entry.
 */
export async function installApp(app, { launch = true, env = process.env } = {}) {
  const url = app.start_url ?? app.url;
  const browser = findBrowser(env);
  const done = { slug: app.slug, url, browser: browser?.name ?? null, entry: null, launched: false, method: browser?.tron ? 'tron' : 'cli' };
  if (!browser) return { ...done, error: 'no Chromium-family browser found; install TronBrowser (https://tronbrowser.dev) or Chrome, or set PWAMART_BROWSER' };

  if (platform() === 'linux') {
    const dir = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications');
    await mkdir(dir, { recursive: true });
    const iconPath = await saveIcon(app.icon, app.slug);
    const file = join(dir, `pwamart-${app.slug}.desktop`);
    await writeFile(file, desktopEntry({ name: app.name, slug: app.slug, url, bin: browser.bin, iconPath, summary: app.summary }));
    await chmod(file, 0o755);
    spawnSync('update-desktop-database', [dir], { stdio: 'ignore' });
    done.entry = file;
  }

  if (launch) {
    const child = spawn(browser.bin, appArgs(url, app.slug), { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    done.launched = true;
  }
  return done;
}
