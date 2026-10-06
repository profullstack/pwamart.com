/**
 * pwamart Desktop.
 *
 * The store window is pwamart.com itself; its Install button calls
 * window.pwamart.install() (preload.cjs) instead of showing browser steps. An
 * installed app gets:
 *  - its own window, with its own storage partition, so logins never mix;
 *  - a launcher entry: a freedesktop .desktop file on Linux, a Start menu shortcut
 *    on Windows, the Dock menu on macOS; each relaunches this app with --open=<slug>;
 *  - a row in the "Apps" menu.
 */
const { app, BrowserWindow, Menu, nativeImage, net, session, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const STORE = process.env.PWAMART_URL || 'https://pwamart.com';
const DATA = app.getPath('userData');
const REGISTRY = path.join(DATA, 'apps.json');
const ICONS = path.join(DATA, 'icons');
const windows = new Map();

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
};
const save = (apps) => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(apps, null, 2));
};
const SLUG = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

function launchArgs(slug) {
  // A packaged app relaunches itself; in development the script path comes first.
  return app.isPackaged ? [`--open=${slug}`] : [path.resolve(process.argv[1] ?? '.'), `--open=${slug}`];
}

async function fetchIcon(url, slug) {
  if (!url) return null;
  try {
    const res = await net.fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    fs.mkdirSync(ICONS, { recursive: true });
    const file = path.join(ICONS, `${slug}.png`);
    fs.writeFileSync(file, img.resize({ width: 256, height: 256 }).toPNG());
    if (process.platform === 'win32') fs.writeFileSync(path.join(ICONS, `${slug}.ico`), img.resize({ width: 256, height: 256 }).toPNG());
    return file;
  } catch {
    return null;
  }
}

function writeLauncher(entry) {
  const exe = process.env.APPIMAGE || process.execPath;
  if (process.platform === 'linux') {
    const dir = path.join(process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const q = (s) => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;
    const file = path.join(dir, `pwamart-${entry.slug}.desktop`);
    fs.writeFileSync(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${entry.name.replace(/[\r\n]/g, ' ')}`,
        `Exec=${[exe, ...launchArgs(entry.slug)].map(q).join(' ')}`,
        `Icon=${entry.icon ?? 'applications-internet'}`,
        'Terminal=false',
        'Categories=Network;',
        `StartupWMClass=pwamart-${entry.slug}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return file;
  }
  if (process.platform === 'win32') {
    const file = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${entry.name.replace(/[<>:"/\\|?*]/g, '')}.lnk`);
    shell.writeShortcutLink(file, { target: exe, args: launchArgs(entry.slug).join(' '), icon: entry.icon ?? exe, iconIndex: 0, appUserModelId: `com.pwamart.${entry.slug}` });
    return file;
  }
  return null; // macOS: the Dock menu (below) is the launcher
}

function openApp(slug) {
  const entry = load()[slug];
  if (!entry) return openStore(`/apps/${slug}`);
  if (windows.has(slug)) return windows.get(slug).focus();
  const origin = new URL(entry.url).origin;
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: entry.name,
    icon: entry.icon ?? undefined,
    autoHideMenuBar: true,
    webPreferences: { partition: `persist:app-${slug}`, contextIsolation: true, sandbox: true },
  });
  if (process.platform === 'win32') win.setAppDetails({ appId: `com.pwamart.${slug}` });
  win.loadURL(entry.url);
  // Links that leave the app's origin open in the default browser, like an installed PWA.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  windows.set(slug, win);
  win.on('closed', () => windows.delete(slug));
  return win;
}

let storeWin = null;
function openStore(pathname = '/') {
  if (storeWin && !storeWin.isDestroyed()) {
    storeWin.loadURL(`${STORE}${pathname}`);
    return storeWin.focus();
  }
  storeWin = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'pwamart',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  storeWin.webContents.setUserAgent(`${storeWin.webContents.getUserAgent()} pwamart-desktop/${app.getVersion()}`);
  storeWin.loadURL(`${STORE}${pathname}`);
  storeWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // The store window never leaves the store: "Open in browser" and app sites go to the default browser.
  // Sign in with CoinPay leaves for coinpayportal.com and comes back, so it may stay in
  // the window; the install bridge still answers only the store (fromStore).
  const SIGN_IN = ['https://coinpayportal.com'];
  storeWin.webContents.on('will-navigate', (ev, url) => {
    const origin = new URL(url).origin;
    if (origin !== new URL(STORE).origin && !SIGN_IN.includes(origin)) {
      ev.preventDefault();
      shell.openExternal(url);
    }
  });
}

function buildMenu() {
  const apps = Object.values(load()).sort((a, b) => a.name.localeCompare(b.name));
  const appItems = apps.length
    ? apps.map((a) => ({ label: a.name, click: () => openApp(a.slug) }))
    : [{ label: 'No apps yet: press Install on any listing', enabled: false }];
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Store', submenu: [{ label: 'Home', click: () => openStore('/') }, { label: 'Browse', click: () => openStore('/apps') }, { label: 'Console', click: () => openStore('/console') }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'quit' }] },
    { label: 'Apps', submenu: [...appItems, { type: 'separator' }, ...apps.map((a) => ({ label: `Uninstall ${a.name}`, click: () => uninstall(a.slug) }))] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (process.platform === 'darwin') app.dock.setMenu(Menu.buildFromTemplate(apps.map((a) => ({ label: a.name, click: () => openApp(a.slug) }))));
}

function uninstall(slug) {
  const apps = load();
  const entry = apps[slug];
  if (!entry) return;
  if (entry.launcher) fs.rmSync(entry.launcher, { force: true });
  delete apps[slug];
  save(apps);
  session.fromPartition(`persist:app-${slug}`).clearStorageData().catch(() => {});
  buildMenu();
}

// Only the store's own pages may install: the preload rides along with the store window.
const fromStore = (ev) => {
  try {
    return new URL(ev.senderFrame?.url ?? '').origin === new URL(STORE).origin;
  } catch {
    return false;
  }
};

ipcMain.handle('pwamart:install', async (ev, { slug, url, name, icon }) => {
  if (!fromStore(ev)) throw new Error('not allowed');
  if (!SLUG.test(String(slug)) || !/^https:\/\//.test(String(url))) throw new Error('bad app');
  const entry = { slug, url, name: String(name).slice(0, 80), icon: await fetchIcon(icon, slug), installedAt: new Date().toISOString() };
  entry.launcher = writeLauncher(entry);
  save({ ...load(), [slug]: entry });
  buildMenu();
  openApp(slug);
  return { ok: true, launcher: entry.launcher };
});
ipcMain.handle('pwamart:installed', (ev) => (fromStore(ev) ? Object.keys(load()) : []));

const argOpen = (argv) => argv.find((a) => a.startsWith('--open='))?.slice(7) ?? argv.find((a) => a.startsWith('pwamart://'))?.replace(/^pwamart:\/\/(open\/)?/, '').replace(/\/$/, '');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const slug = argOpen(argv);
    slug ? openApp(slug) : openStore();
  });
  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient('pwamart');
    buildMenu();
    const slug = argOpen(process.argv);
    slug ? openApp(slug) : openStore();
    app.on('activate', () => BrowserWindow.getAllWindows().length || openStore());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}
