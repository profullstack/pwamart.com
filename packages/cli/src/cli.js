/**
 * pwamart: the app store for web apps, from the terminal.
 * PWAMART_API_KEY and PWAMART_URL override the saved config.
 */
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as api from './client.js';
import { installApp } from './install.js';

const HELP = `pwamart: find and install web apps (PWAs) on any device.

Browse
  pwamart search [query] [--category C] [--sort top|new|rating] [--json]
  pwamart info <slug> [--json]
  pwamart install <slug> [--no-launch]   open it as an app window + add a launcher entry
  pwamart uninstall <slug>               remove the launcher entry
  pwamart open <slug>                    open in your default browser
  pwamart categories
  pwamart tui                            the store in your terminal (hqtui)

Publish (needs an API key from pwamart.com/console/keys)
  pwamart login [KEY]
  pwamart whoami
  pwamart publisher <name> [--slug S] [--website URL]
  pwamart check <url>                    grade any URL's installability
  pwamart submit <url> --publisher <slug> [--category C]
  pwamart verify <slug>
  pwamart publish <slug>
  pwamart apps                           your apps and their status

  pwamart health | version

Environment: PWAMART_API_KEY, PWAMART_URL, PWAMART_BROWSER.`;

export function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--no-')) flags[arg.slice(5)] = false;
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else if (arg === '-h') flags.help = true;
    else if (arg === '-v') flags.version = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const stars = (r) => (r ? `★ ${Number(r).toFixed(1)}` : '  new');

export function formatList(r) {
  if (!r.apps.length) return 'No apps found.';
  const w = Math.min(28, Math.max(...r.apps.map((a) => a.slug.length)));
  const lines = r.apps.map(
    (a) => `${a.slug.padEnd(w)}  ${a.name.slice(0, 30).padEnd(30)}  ${stars(a.rating).padEnd(6)}  ${String(a.installs).padStart(6)} ↓  ${a.publisher.name}`,
  );
  return `${lines.join('\n')}\n\n${r.total} app${r.total === 1 ? '' : 's'}${r.total > r.apps.length ? ` (showing ${r.apps.length})` : ''} · pwamart install <slug>`;
}

export function formatApp({ app, publisher }, server = "https://pwamart.com") {
  const req = app.checks.filter((c) => c.level === 'required');
  return [
    `${app.name}  ${app.verified ? '(verified)' : ''}`,
    `by ${publisher?.name ?? app.publisher.name} · ${app.category_name} · ${stars(app.rating)} (${app.rating_count}) · ${app.installs} installs`,
    '',
    app.summary ?? '',
    '',
    `URL       ${app.start_url}`,
    `Page      ${server}/apps/${app.slug}`,
    `Score     ${app.score ?? '–'}%  ${req.map((c) => `${c.ok ? '✓' : '✕'} ${c.label}`).join('  ')}`,
    `iOS       ${server}/apps/${app.slug}/install.mobileconfig`,
    `Install   pwamart install ${app.slug}`,
  ].join('\n');
}

const openUrl = (url) => {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return import('node:child_process').then(({ spawn }) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref());
};

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parse(argv);
  const [cmd, ...rest] = positional;
  if (flags.version || cmd === 'version') {
    const { createRequire } = await import('node:module');
    console.log(createRequire(import.meta.url)('../package.json').version);
    return 0;
  }
  if (!cmd || flags.help || cmd === 'help') {
    console.log(HELP);
    return 0;
  }
  const auth = await api.resolveAuth({ server: flags.server, key: flags.key });
  const out = (v, text) => console.log(flags.json ? JSON.stringify(v, null, 2) : text);
  switch (cmd) {
    case 'health': {
      const h = await api.health(auth);
      console.log(`${auth.server}  ok=${h.ok}  v${h.version}`);
      return h.ok ? 0 : 1;
    }
    case 'search':
    case 'ls': {
      const r = await api.search(auth, { q: rest.join(' ') || undefined, category: flags.category, sort: flags.sort, limit: flags.limit ?? 20 });
      out(r, formatList(r));
      return 0;
    }
    case 'categories': {
      const r = await api.categories(auth);
      out(r, r.categories.map((c) => `${c.slug.padEnd(18)} ${c.name.padEnd(20)} ${c.apps}`).join('\n'));
      return 0;
    }
    case 'info':
    case 'show': {
      if (!rest[0]) throw new Error('usage: pwamart info <slug>');
      const r = await api.getApp(auth, rest[0]);
      out(r, formatApp(r, auth.server));
      return 0;
    }
    case 'install': {
      if (!rest[0]) throw new Error('usage: pwamart install <slug>');
      const { app } = await api.getApp(auth, rest[0]);
      const r = await installApp(app, { launch: flags.launch !== false });
      if (r.error) throw new Error(r.error);
      await api.countInstall(auth, app.slug, r.method).catch(() => {});
      console.log(`✓ ${app.name}${r.launched ? ` opened as an app window in ${r.browser}` : ''}`);
      if (r.entry) console.log(`  launcher entry: ${r.entry}`);
      if (process.platform !== 'linux') console.log('  Tip: use the browser\'s "Install" button in that window to keep it in your dock or Start menu.');
      return 0;
    }
    case 'uninstall':
    case 'remove': {
      if (!rest[0]) throw new Error('usage: pwamart uninstall <slug>');
      const file = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', `pwamart-${rest[0]}.desktop`);
      await rm(file, { force: true });
      console.log(`✓ removed ${file}`);
      return 0;
    }
    case 'open': {
      const { app } = await api.getApp(auth, rest[0]);
      await openUrl(app.start_url);
      await api.countInstall(auth, app.slug, 'open').catch(() => {});
      return 0;
    }
    case 'tui': {
      const { runTui } = await import('./tui.js');
      await runTui(auth, { q: rest.join(' ') || undefined });
      return 0;
    }
    case 'login': {
      let key = rest[0];
      if (!key) {
        process.stderr.write(`Create a key at ${auth.server}/console/keys\n`);
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        key = (await rl.question('API key: ')).trim();
        rl.close();
      }
      if (!key.startsWith('pm_live_')) throw new Error('that does not look like a pwamart key (pm_live_…)');
      const m = await api.me({ ...auth, key });
      const file = await api.saveConfig({ key, server: auth.server });
      process.stderr.write(`Signed in as ${m.user.email}. Saved to ${file}.\n`);
      return 0;
    }
    case 'whoami': {
      const m = await api.me(auth);
      out(m, `${m.user.email} · ${m.plan.name} · ${m.usage.publishers} publisher(s), ${m.usage.apps} app(s)\npublishers: ${m.publishers.map((p) => p.slug).join(', ') || 'none'}`);
      return 0;
    }
    case 'publisher': {
      const name = rest.join(' ');
      if (!name) throw new Error('usage: pwamart publisher <name> [--slug s]');
      const r = await api.createPublisher(auth, { name, slug: flags.slug, website: flags.website, org: flags.org });
      out(r, `✓ publisher ${r.publisher.slug}`);
      return 0;
    }
    case 'check':
    case 'inspect': {
      const r = await api.inspect(auth, rest[0]);
      out(r, [`${r.app.name}  ${r.installable ? 'installable' : 'NOT installable'}  ${r.score}%`, ...r.checks.map((c) => `  ${c.ok ? '✓' : c.level === 'required' ? '✕' : '○'} ${c.label}${c.ok ? '' : `: ${c.hint}`}`)].join('\n'));
      return r.installable ? 0 : 1;
    }
    case 'submit': {
      if (!rest[0] || !flags.publisher) throw new Error('usage: pwamart submit <url> --publisher <slug>');
      const r = await api.submit(auth, { url: rest[0], publisher: flags.publisher, category: flags.category, slug: flags.slug });
      out(
        r,
        [
          `✓ draft ${r.app.slug} (${r.app.score}% installable)`,
          r.verify.verified ? '  origin already verified: pwamart publish ' + r.app.slug : '  prove you own the origin, any one of:',
          ...(r.verify.verified ? [] : r.verify.options.map((o) => `    ${o.how}`)),
          r.verify.verified ? '' : `  then: pwamart verify ${r.app.slug} && pwamart publish ${r.app.slug}`,
        ].join('\n'),
      );
      return 0;
    }
    case 'verify': {
      const r = await api.verify(auth, rest[0]);
      out(r, `✓ verified (${r.method})`);
      return 0;
    }
    case 'publish': {
      const r = await api.publish(auth, rest[0]);
      out(r, `✓ ${rest[0]} is ${r.status}: ${auth.server}/apps/${rest[0]}`);
      return 0;
    }
    case 'apps': {
      const r = await api.myApps(auth);
      out(r, r.apps.map((a) => `${a.slug.padEnd(24)} ${a.status.padEnd(10)} ${a.verified ? 'verified  ' : 'unverified'} ${String(a.score ?? '–').padStart(3)}%  ${a.installs} installs`).join('\n') || 'No apps yet: pwamart submit <url> --publisher <slug>');
      return 0;
    }
    default:
      throw new Error(`unknown command ${cmd}; try pwamart help`);
  }
}
