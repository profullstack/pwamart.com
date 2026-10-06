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

Account (OAuth 2.1: opens your browser, no keys to paste)
  pwamart login [--manual]               sign in; --manual prints a URL + asks for a code (SSH)
  pwamart login --key pm_live_…          or use an API key from pwamart.com/console/keys
  pwamart logout                         revoke this sign-in and forget it
  pwamart whoami

Publish
  pwamart publisher <name> [--slug S] [--website URL]
  pwamart publisher show <slug>          profile + how to verify its website
  pwamart publisher fill <slug> [--url U] [--save]   read the website for a logo and bio
  pwamart publisher edit <slug> [--logo URL] [--bio T] [--website URL] [--name N]
  pwamart publisher verify <slug>        prove the website (manifest, file, meta or DNS)
  pwamart check <url>                    grade any URL's installability
  pwamart submit <url> --publisher <slug> [--category C]
  pwamart verify <slug>
  pwamart publish <slug>
  pwamart apps                           your apps and their status
  pwamart feature <slug>                 $19: 7 days featured + the next newsletter (CoinPay)
  pwamart subscribe <email>              the pwamart newsletter (double opt-in)
  pwamart releases <slug>                what's new in an app
  pwamart release <slug> --title T [--version V] [--notes N]   post a release (followers are notified)
  pwamart follow <slug> [--publisher] [--email E]              get notified of updates (or a publisher's new apps)
  pwamart following                      what you follow
  pwamart unfollow <slug> [--publisher]

  pwamart upgrade | update               install the latest pwamart
  pwamart uninstall | remove             remove pwamart itself (with no <slug>)
  pwamart health | version

Install:  curl -fsSL https://pwamart.com/install.sh | sh
Upgrade:  curl -fsSL https://pwamart.com/upgrade.sh | sh
Remove:   curl -fsSL https://pwamart.com/uninstall.sh | sh

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
      if (!rest[0]) {
        const { spawnSync } = await import('node:child_process');
        const { logout } = await import('@profullstack/auth-system/cli');
        await logout({ store: api.tokenStore() }).catch(() => {});
        const r = spawnSync('sh', ['-c', `curl -fsSL ${auth.server}/install.sh | sh -s -- --uninstall${flags.purge ? ' --purge' : ''}`], { stdio: 'inherit' });
        return r.status ?? 1;
      }
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
      const key = typeof flags.key === 'string' ? flags.key : rest[0]?.startsWith('pm_live_') ? rest[0] : null;
      if (key) {
        if (!key.startsWith('pm_live_')) throw new Error('that does not look like a pwamart key (pm_live_…)');
        const m = await api.me({ ...auth, key });
        const file = await api.saveConfig({ key, server: auth.server });
        process.stderr.write(`Signed in as ${m.user.email} with an API key. Saved to ${file}.\n`);
        return 0;
      }
      const { login } = await import('@profullstack/auth-system/cli');
      const store = api.tokenStore();
      await login({
        issuer: auth.server,
        clientId: 'pwamart-cli',
        scope: 'read write',
        store,
        manual: flags.manual === true ? true : undefined,
        manualRedirectUri: `${auth.server}/oauth/cli`,
      });
      const m = await api.me(await api.resolveAuth({ server: auth.server }));
      process.stderr.write(`Signed in as ${m.user.email}. The CLI, TUI and MCP server share this sign-in (${store.file}).\n`);
      return 0;
    }
    case 'logout': {
      const { logout } = await import('@profullstack/auth-system/cli');
      const had = await logout({ store: api.tokenStore() });
      const cfg = await api.loadConfig();
      if (cfg.key) await api.saveConfig({ key: undefined });
      process.stderr.write(had || cfg.key ? 'Signed out.\n' : 'Not signed in.\n');
      return 0;
    }
    case 'upgrade':
    case 'update': {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('sh', ['-c', `curl -fsSL ${auth.server}/install.sh | sh -s -- --upgrade`], { stdio: 'inherit' });
      return r.status ?? 1;
    }
    case 'whoami': {
      const m = await api.me(auth);
      out(m, `${m.user.email} · ${m.plan.name} · ${m.usage.publishers} publisher(s), ${m.usage.apps} app(s)\npublishers: ${m.publishers.map((p) => p.slug).join(', ') || 'none'}`);
      return 0;
    }
    case 'publisher': {
      const [sub, slug] = rest;
      if (['show', 'fill', 'edit', 'verify'].includes(sub)) {
        if (!slug) throw new Error(`usage: pwamart publisher ${sub} <slug>`);
        if (sub === 'show') {
          const r = await api.managePublisher(auth, slug);
          const p = r.publisher;
          out(r, [
            `${p.name}  ${p.verified ? `verified${p.verified_domain ? ` (${p.verified_domain})` : ''}` : 'unverified'}`,
            `website  ${p.website ?? '–'}`,
            `logo     ${p.avatar_url ?? '–'}`,
            `bio      ${p.bio ?? '–'}`,
            ...(p.verified ? [] : ['', `Verify ${r.verify.domain ?? 'your website'} with any one of:`, ...r.verify.options.map((o) => `  ${o.method.padEnd(10)} ${o.how}`), ...(r.verify.note ? [`  ${r.verify.note}`] : []), `then: pwamart publisher verify ${slug}`]),
          ].join('\n'));
          return 0;
        }
        if (sub === 'fill') {
          const { suggestion: s } = await api.autofillPublisher(auth, slug, flags.url);
          if (flags.save) {
            const body = { website: s.website, ...(s.logo && { avatar_url: s.logo }), ...(s.bio && { bio: s.bio }) };
            const r = await api.updatePublisher(auth, slug, body);
            out({ suggestion: s, publisher: r.publisher }, `✓ saved: logo ${s.logo ?? '–'}, bio ${s.bio ? `(${s.bio_source})` : '–'}`);
          } else out({ suggestion: s }, [`name     ${s.name}`, `website  ${s.website}`, `logo     ${s.logo ?? '–'}${s.logo_source ? `  (${s.logo_source})` : ''}`, `bio      ${s.bio ?? '–'}${s.bio_source ? `  (${s.bio_source === 'ai' ? 'written by AI from the page' : 'from the site'})` : ''}`, '', `save it: pwamart publisher fill ${slug} --save`].join('\n'));
          return 0;
        }
        if (sub === 'edit') {
          const body = { ...(flags.logo !== undefined && { avatar_url: flags.logo }), ...(flags.bio !== undefined && { bio: flags.bio }), ...(flags.website && { website: flags.website }), ...(flags.name && { name: flags.name }) };
          if (!Object.keys(body).length) throw new Error('usage: pwamart publisher edit <slug> [--logo URL] [--bio T] [--website URL] [--name N]');
          const r = await api.updatePublisher(auth, slug, body);
          out(r, `✓ ${r.publisher.slug} updated${r.notice ? `\n${r.notice}` : ''}`);
          return 0;
        }
        const r = await api.verifyPublisher(auth, slug);
        out(r, `✓ ${slug} verified (${r.method})`);
        return 0;
      }
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
    case 'feature': {
      if (!rest[0]) throw new Error('usage: pwamart feature <slug>');
      const st = await api.featured(auth, rest[0]);
      const r = await api.feature(auth, rest[0]);
      out(
        r,
        [
          st.featured ? `${rest[0]} is featured${st.featured_until ? ` until ${String(st.featured_until).slice(0, 10)}; this adds ${r.days} days` : ''}.` : '',
          `Pay $${r.price_cents / 100} in crypto to feature ${rest[0]} for ${r.days} days and in the next newsletter:`,
          `  ${r.checkout_url}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
      if (!flags.json && !flags['no-open']) await openUrl(r.checkout_url).catch(() => {});
      return 0;
    }
    case 'releases': {
      if (!rest[0]) throw new Error('usage: pwamart releases <slug>');
      const r = await api.releases(auth, rest[0]);
      out(r, r.releases.map((x) => `${x.created_at.slice(0, 10)}  ${x.kind.padEnd(9)} ${x.version ? `${x.version}  ` : ''}${x.title}${x.notes ? `\n            ${x.notes.split('\n')[0]}` : ''}`).join('\n') || 'No releases yet.');
      return 0;
    }
    case 'release': {
      if (!rest[0] || typeof flags.title !== 'string') throw new Error('usage: pwamart release <slug> --title "What changed" [--version 1.2] [--notes "…"]');
      const r = await api.postRelease(auth, rest[0], { title: flags.title, version: flags.version, notes: flags.notes });
      out(r, `✓ released ${r.release.version ?? ''} "${r.release.title}"; followers will be notified`);
      return 0;
    }
    case 'follow': {
      if (!rest[0]) throw new Error('usage: pwamart follow <slug> [--publisher] [--email you@example.com]');
      const r = await api.follow(auth, { kind: flags.publisher ? 'publisher' : 'app', slug: rest[0], email: flags.email });
      out(r, r.confirmed ? `✓ following ${r.target.name}` : `Check ${flags.email} for a confirmation link.`);
      return 0;
    }
    case 'following': {
      const r = await api.follows(auth);
      out(r, r.follows.map((f) => `${f.target_kind.padEnd(10)} ${f.slug.padEnd(28)} ${f.name}`).join('\n') || 'Not following anything yet: pwamart follow <slug>');
      return 0;
    }
    case 'unfollow': {
      const kind = flags.publisher ? 'publisher' : 'app';
      const r = await api.follows(auth);
      const f = r.follows.find((x) => x.slug === rest[0] && x.target_kind === kind);
      if (!f) throw new Error(`not following ${kind} ${rest[0]}`);
      await api.unfollow(auth, f.id);
      console.log(`✓ unfollowed ${f.name}`);
      return 0;
    }
    case 'subscribe': {
      if (!rest[0]) throw new Error('usage: pwamart subscribe <email>');
      const r = await api.subscribe(auth, rest[0]);
      out(r, `✓ ${r.message}`);
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
