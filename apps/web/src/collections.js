import { listApps } from './catalog.js';

/**
 * Collections: apps grouped by the agentic workflow they serve, each installable in
 * one go (like bundl.run's collections, for agents instead of Mac apps). Curated
 * ones name slugs; the rest are rules over detected surfaces, so they grow on their
 * own. A slug that is not published is skipped, and an empty collection is hidden.
 *
 * Every collection has:
 *   /collections/<slug>/install.sh  every member's own `curl | sh` installer, in turn
 *   /collections/<slug>/mcp.json    every member's MCP server, as an mcpServers config
 * Both take ?apps=a,b to install only some members.
 */

export const SECTIONS = [
  ['workflows', 'Agentic workflows'],
  ['surfaces', 'By surface'],
];

export const COLLECTIONS = [
  {
    slug: 'agentic-coding',
    section: 'workflows',
    title: 'Agentic coding',
    subtitle: 'Drive coding agents, run them on spare GPUs and ship what they write',
    apps: ['moshcode', 'hqtui', 'tronbrowser', 'w3bs', 'logicsrc', 'p2p-one', 'infernet-protocol', 'tsbb'],
  },
  {
    slug: 'agent-payments',
    section: 'workflows',
    title: 'Agents that get paid',
    subtitle: 'Take crypto payments, post gigs and hire agents or people',
    apps: ['coinpay', 'ugig-net', 'agentic-jobs', 'b1dz', 'advis0r-com'],
  },
  {
    slug: 'agent-ops',
    section: 'workflows',
    title: 'Ops & security',
    subtitle: 'Watch, defend, back up and wire up what your agents run on',
    apps: ['threatcrush', 'crawlproof', 'diskpush', 'r4ck', 'meshhook', 'd3vices'],
  },
  {
    slug: 'agent-growth',
    section: 'workflows',
    title: 'Growth & distribution',
    subtitle: 'Post everywhere, syndicate feeds and find the people to reach',
    apps: ['myna', 'rss-amplifier', 'outreachgraph', 'bl0ggers', 'bufferoverride', 'p0dcasters', 'postammo'],
  },
  {
    slug: 'agent-research',
    section: 'workflows',
    title: 'Research & data',
    subtitle: 'Datasets, media analysis and the news, in a form an agent can read',
    apps: ['nichedb', 'mediaanalyzer', 'media2markdown', 'watchnews', 'brisk-news', 'typeheard', 'genrewatch'],
  },
  {
    slug: 'agent-humans',
    section: 'workflows',
    title: 'Talk to humans',
    subtitle: 'Text, call, chat and pair with the people your agents work for',
    apps: ['smshub', 'qryptchat', 'pairux', 'opensocial', 'phonenumbers-bot'],
  },
  {
    slug: 'mcp-servers',
    section: 'surfaces',
    title: 'MCP servers',
    subtitle: 'Every listing with an MCP server, ready to add to Claude, Cursor or any client',
    surface: 'mcp',
  },
  {
    slug: 'clis',
    section: 'surfaces',
    title: 'Terminal tools',
    subtitle: 'Every listing with a CLI, each installed by its own curl | sh',
    surface: 'cli',
  },
  {
    slug: 'apis',
    section: 'surfaces',
    title: 'HTTP APIs',
    subtitle: 'Every listing with an API an agent can call directly',
    surface: 'api',
  },
];

export const getCollection = (slug) => COLLECTIONS.find((c) => c.slug === String(slug ?? '').toLowerCase()) ?? null;

/** A collection's live members, in its curated order. */
export async function collectionApps(col, { list = listApps } = {}) {
  if (col.surface) return (await list({ surface: col.surface, sort: 'top', limit: 100 })).apps;
  const { apps } = await list({ slugs: col.apps, limit: 100 });
  const order = new Map(col.apps.map((s, i) => [s, i]));
  return apps.sort((a, b) => order.get(a.slug) - order.get(b.slug));
}

let overview = { at: 0, list: null };
/** Every non-empty collection with its members, cached a minute (the home page shows them). */
export async function allCollections(siteUrl) {
  if (overview.list && Date.now() - overview.at < 60_000 && process.env.NODE_ENV !== 'test') return overview.list;
  const list = (await Promise.all(COLLECTIONS.map(async (col) => summarize(col, await collectionApps(col), siteUrl)))).filter((c) => c.counts.apps);
  overview = { at: Date.now(), list };
  return list;
}

/** `?apps=a,b` narrowed to members; no list (or nothing that matches) means all of them. */
export function pick(apps, only) {
  const want = new Set(String(only ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const picked = want.size ? apps.filter((a) => want.has(a.slug)) : [];
  return picked.length ? picked : apps;
}

export const counts = (apps) => ({
  apps: apps.length,
  cli: apps.filter((a) => a.surfaces?.cli?.install).length,
  mcp: apps.filter((a) => a.surfaces?.mcp).length,
  api: apps.filter((a) => a.surfaces?.api).length,
});

/** What the API, the MCP tool and the CLI show for one collection. */
export function summarize(col, apps, siteUrl) {
  const base = `${siteUrl}/collections/${col.slug}`;
  return {
    slug: col.slug,
    title: col.title,
    subtitle: col.subtitle,
    section: col.section,
    page: base,
    counts: counts(apps),
    install: {
      cli: `curl -fsSL ${base}/install.sh | sh`,
      mcp_config: `${base}/mcp.json`,
      ios_profile: `${siteUrl}/bundle.mobileconfig?apps=${apps.map((a) => a.slug).join(',')}`,
    },
    apps: apps.map((a) => ({ slug: a.slug, name: a.name, summary: a.summary, icon: a.icon, url: a.start_url, page: `${siteUrl}/apps/${a.slug}`, surfaces: a.surfaces })),
  };
}

/* ------------------------------------------------------------ installers -- */

// Only plain https URLs go into a shell script: no quotes, spaces or backslashes.
const SAFE_URL = /^https:\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[A-Za-z0-9._~\-\/%+=&?#@:,!]*)?$/;

/** One script that runs each member's own installer, carries on past a failure and reports. */
export function installScript(col, apps, siteUrl) {
  const runs = apps
    .map((a) => ({ slug: a.slug, url: a.surfaces?.cli?.script, shell: a.surfaces?.cli?.install?.endsWith('| bash') ? 'bash' : 'sh' }))
    .filter((r) => r.url && SAFE_URL.test(r.url) && /^[a-z0-9-]+$/.test(r.slug));
  const lines = [
    '#!/bin/sh',
    `# pwamart collection: ${col.title.replace(/[^\w &.,-]/g, '')}`,
    `# ${siteUrl}/collections/${col.slug}`,
    '#',
    "# Runs each app's own installer, exactly as its publisher serves it. To read one",
    '# first: curl -fsSL <url>. Nothing here needs root unless an installer asks for it.',
    'set -u',
    'ok=0',
    'failed=""',
    'run() {',
    '  printf "\\n==> %s  (%s)\\n" "$1" "$2"',
    '  if curl -fsSL "$2" | "$3"; then ok=$((ok + 1)); else failed="$failed $1"; fi',
    '}',
    ...runs.map((r) => `run '${r.slug}' '${r.url}' ${r.shell}`),
    `printf "\\n%s of ${runs.length} installed.\\n" "$ok"`,
    '[ -z "$failed" ] || { printf "Failed:%s\\n" "$failed"; exit 1; }',
    '',
  ];
  if (!runs.length) return ['#!/bin/sh', `echo "No app in this collection has a CLI yet: ${siteUrl}/collections/${col.slug}"`, ''].join('\n');
  return lines.join('\n');
}

/** Every member's MCP server as one config: Claude Code (.mcp.json), Claude Desktop, Cursor. */
export function mcpConfig(apps) {
  const servers = {};
  for (const a of apps) {
    const m = a.surfaces?.mcp;
    if (!m) continue;
    if (m.url) servers[a.slug] = { type: 'http', url: m.url };
    else if (m.stdio) {
      const [, ...args] = m.stdio.split(' ');
      servers[a.slug] = { command: 'npx', args };
    }
  }
  return { mcpServers: servers };
}

/** `claude mcp add` for each member's MCP server. */
export const claudeMcpLines = (apps) =>
  apps
    .filter((a) => a.surfaces?.mcp)
    .map((a) => (a.surfaces.mcp.url ? `claude mcp add --transport http ${a.slug} ${a.surfaces.mcp.url}` : `claude mcp add ${a.slug} -- ${a.surfaces.mcp.stdio}`));
