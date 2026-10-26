/**
 * pwamart tui: the store in a terminal, on hqtui.
 *
 * Left: search + results. Right: the selected app. One click (or Enter) on a row
 * shows it; `i` installs it as an app window, `o` opens it in the browser.
 * `/` searches, `c` cycles categories, `s` cycles sort, `u` upvotes the app,
 * `l` shows the karma leaderboard, q quits.
 */
import { createApp } from '@profullstack/hqtui';
import { categories, countInstall, getApp, leaderboard, search, vote } from './client.js';
import { installApp } from './install.js';

const SORTS = ['top', 'votes', 'new', 'rating', 'name'];

export function initialState({ q } = {}) {
  return { q: q ?? '', editing: false, cats: [], cat: -1, sort: 0, list: null, selected: 0, detail: null, board: null, status: 'Loading…', busy: false };
}

const stars = (r) => (r ? `★ ${Number(r).toFixed(1)}` : 'new');

/** The whole screen as a pure function of state, so tests can render it. */
export function view(state) {
  return ({ ui, theme }) => {
    const apps = state.list?.apps ?? [];
    const cat = state.cat >= 0 ? state.cats[state.cat] : null;
    ui.column({ gap: 0 }, (root) => {
      root.row({ gap: 1, size: '1fr' }, (row) => {
        row.column({ size: '42%', gap: 0 }, (left) => {
          left.panel({ title: 'pwamart · the app store for web apps', subtitle: `${state.list?.total ?? 0} apps`, titleColor: theme.accent, size: 4 }, (p) => {
            p.textInput({ value: state.q, placeholder: 'press / to search', focused: state.editing, label: 'search ' });
            p.text(`${cat ? cat.name : 'All categories'} · sorted by ${SORTS[state.sort]}`, { fg: theme.muted });
          });
          left.panel({ title: 'Apps', size: '1fr' }, (p) => {
            if (!apps.length) p.text(state.list ? 'Nothing matches.' : 'Loading…', { fg: theme.muted });
            else
              p.list({
                // hqtui declares ListOptions.badge but does not draw it, so the category is part of the label.
                items: apps.map((a) => ({ label: `${a.name.padEnd(22).slice(0, 22)} ${(a.category_name ?? "").padEnd(18).slice(0, 18)} ${a.rating ? stars(a.rating) : ""}` })),
                selected: state.selected,
                followSelection: true,
                scrollbar: true,
                size: '1fr',
                onSelectRow: (i) => state.onPick?.(i),
              });
          });
        });
        row.panel({ title: state.board ? 'Top karma' : state.detail?.app?.name ?? 'Details', size: '1fr' }, (p) => {
          if (state.board) {
            const b = state.board;
            p.text(b.fallback ? 'All time (nobody yet this week)' : 'This week', { fg: theme.muted });
            p.text('');
            if (!b.rows.length) p.text('Nobody yet: upvote, review or comment to be first.', { fg: theme.muted });
            for (const r of b.rows) p.text(`${String(r.rank).padStart(3)}  ${r.name.slice(0, 24).padEnd(24)} ${String(r.display).padStart(6)} ${r.badges.map((x) => x.emoji).join('')}`);
            p.text('');
            p.text('Upvote (+1), review (+5), comment (+2), share (+1), publish (+10). 500 = a free Featured week.', { fg: theme.muted, wrap: true });
            p.text('Press l to go back.', { fg: theme.muted });
            return;
          }
          const d = state.detail;
          if (!d) {
            p.text(apps.length ? 'Pick an app with ↑/↓ or a click.' : '', { fg: theme.muted });
            return;
          }
          const a = d.app;
          p.text(`by ${a.publisher.name}${a.publisher.verified ? ' ✓' : ''} · ${a.category_name}`, { fg: theme.muted });
          p.text(`▲ ${a.votes ?? 0}   ${stars(a.rating)} (${a.rating_count})   ${a.installs} installs   PWA score ${a.score ?? '–'}%   ${a.verified ? 'verified' : 'unverified'}`);
          p.text('');
          if (a.summary) p.text(a.summary, { fg: theme.accent, wrap: true });
          p.text((a.description ?? '').slice(0, 900), { wrap: true });
          p.text('');
          p.text(`URL   ${a.start_url}`);
          p.text(`iOS   ${state.server ?? 'https://pwamart.com'}/apps/${a.slug}/install.mobileconfig`);
          p.text(`CLI   pwamart install ${a.slug}`);
          p.text('');
          for (const c of a.checks.filter((x) => x.level === 'required')) p.text(`${c.ok ? '✓' : '✕'} ${c.label}`, { fg: c.ok ? theme.success : theme.danger });
        });
      });
      root.statusBar({
        items: [
          { key: '/', label: 'search' },
          { key: 'i', label: 'install' },
          { key: 'o', label: 'open' },
          { key: 'u', label: 'upvote' },
          { key: 'l', label: 'karma' },
          { key: 'c', label: 'category' },
          { key: 's', label: 'sort' },
          { key: 'q', label: 'quit' },
        ],
        right: [{ label: state.status }],
      });
    });
  };
}

export async function runTui(auth, opts = {}) {
  const state = { ...initialState(opts), server: auth.server };
  const app = await createApp({ fps: 20, quitKeys: [], mouse: true });
  const redraw = () => app.invalidate();

  const loadDetail = async () => {
    const a = state.list?.apps?.[state.selected];
    if (!a) return;
    try {
      state.detail = await getApp(auth, a.slug);
    } catch (err) {
      state.status = err.message;
    }
    redraw();
  };
  const load = async () => {
    state.status = 'Loading…';
    redraw();
    try {
      const cat = state.cat >= 0 ? state.cats[state.cat].slug : undefined;
      state.list = await search(auth, { q: state.q || undefined, category: cat, sort: SORTS[state.sort], limit: 100 });
      state.selected = 0;
      state.detail = null;
      state.status = `${state.list.total} apps · ${auth.server.replace(/^https?:\/\//, '')}`;
      await loadDetail();
    } catch (err) {
      state.list = { total: 0, apps: [] };
      state.status = err.message;
    }
    redraw();
  };
  state.onPick = (i) => {
    state.selected = i;
    void loadDetail();
  };

  const install = async () => {
    const a = state.detail?.app;
    if (!a || state.busy) return;
    state.busy = true;
    state.status = `Installing ${a.name}…`;
    redraw();
    try {
      const r = await installApp(a);
      if (r.error) throw new Error(r.error);
      await countInstall(auth, a.slug, r.method).catch(() => {});
      state.status = `✓ ${a.name} opened in ${r.browser}${r.entry ? ' · launcher entry written' : ''}`;
    } catch (err) {
      state.status = err.message;
    }
    state.busy = false;
    redraw();
  };

  app.on('key', (ev) => {
    if (state.editing) {
      if (ev.name === 'enter' || ev.name === 'escape') {
        state.editing = false;
        if (ev.name === 'enter') void load();
      } else if (ev.name === 'backspace') state.q = state.q.slice(0, -1);
      else if (ev.char && !ev.ctrl) state.q += ev.char;
      return redraw();
    }
    if (ev.key === 'ctrl+c' || ev.char === 'q') return app.quit();
    const n = state.list?.apps?.length ?? 0;
    if ((ev.name === 'up' || ev.name === 'down' || ev.char === 'k' || ev.char === 'j') && n) {
      const up = ev.name === 'up' || ev.char === 'k';
      state.selected = (state.selected + (up ? -1 : 1) + n) % n;
      void loadDetail();
    } else if (ev.char === '/') state.editing = true;
    else if (ev.name === 'enter' || ev.char === 'i') void install();
    else if (ev.char === 'o' && state.detail) {
      import('node:child_process').then(({ spawn }) => {
        const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(cmd, [state.detail.app.start_url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      });
      countInstall(auth, state.detail.app.slug, 'open').catch(() => {});
    } else if (ev.char === 'c' && state.cats.length) {
      state.cat = state.cat + 1 >= state.cats.length ? -1 : state.cat + 1;
      void load();
    } else if (ev.char === 's') {
      state.sort = (state.sort + 1) % SORTS.length;
      void load();
    } else if (ev.char === 'u' && state.detail) {
      const a = state.detail.app;
      vote(auth, a.slug)
        .then((r) => {
          a.votes = r.votes;
          state.status = `▲ upvoted ${a.name}${r.karma?.paid ? ` · +${r.karma.points} karma` : ''}`;
        })
        .catch((err) => (state.status = err.status === 401 ? 'Sign in first: pwamart login' : err.message))
        .finally(redraw);
    } else if (ev.char === 'l') {
      if (state.board) state.board = null;
      else
        leaderboard(auth, { period: 'week', limit: 20 })
          .then((b) => (state.board = b))
          .catch((err) => (state.status = err.message))
          .finally(redraw);
    } else if (ev.char === 'r') void load();
    redraw();
  });

  app.render(view(state));
  categories(auth)
    .then((r) => {
      state.cats = r.categories.filter((c) => c.apps > 0);
      redraw();
    })
    .catch(() => {});
  void load();
  await app.start();
}

/** The screen as plain text, for tests and screenshots without a terminal. */
export async function renderStore(state, options = { width: 120, height: 30 }) {
  const { renderToText } = await import('@profullstack/hqtui/testing');
  return renderToText(view(state), options);
}
