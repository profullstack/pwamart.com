/**
 * pwamart's MCP tools, one definition for both transports:
 *  - stdio (src/server.js, `npx @profullstack/pwamart-mcp`): `call` goes over the
 *    network to /api/v1 with PWAMART_API_KEY;
 *  - hosted (POST https://pwamart.com/mcp, in the web app): `call` is an in-process
 *    request to /api/v1 carrying the caller's Authorization header.
 * Either way a tool can do nothing the API would refuse. No imports, so the web
 * app can load it without the CLI package.
 */

export const PROTOCOL_VERSION = '2025-06-18';

export const TOOLS = [
  {
    name: 'search_apps',
    description: 'Search the pwamart catalog of installable web apps (PWAs). Returns name, slug, summary, publisher, rating, installs and the URL to open.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'free text, e.g. "markdown notes"' },
        category: { type: 'string', description: 'category slug from list_categories' },
        sort: { type: 'string', enum: ['top', 'new', 'rating', 'name'] },
        feature: { type: 'string', enum: ['offline'], description: 'only apps with this detected feature; offline = its service worker answers from a cache' },
        offline: { type: 'boolean', description: 'shorthand for feature: "offline"' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_app',
    description: 'Full details of one app by slug: description, screenshots, installability checks, publisher and install instructions for every platform.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'list_categories',
    description: 'Every category with how many apps it has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'install_app',
    description:
      'How to install an app on a given platform, plus the URL to open. An agent with a shell can run the returned command; otherwise show the steps to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        platform: { type: 'string', enum: ['ios', 'android', 'desktop', 'linux', 'macos', 'windows', 'tron'] },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_app',
    description: 'List a PWA: inspects the URL and creates a draft under one of your publishers. Needs PWAMART_API_KEY (Bearer pm_live_...).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        publisher: { type: 'string', description: 'publisher slug' },
        category: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['url', 'publisher'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_app',
    description: 'Check the domain-ownership token for a draft app. Needs an API key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'fill_publisher',
    description:
      'Read a website and suggest a publisher name, logo and bio (from its manifest and page; the bio is written by AI only when the site has no description). Saves only when save is true. Needs an API key.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'publisher slug' }, url: { type: 'string', description: 'website to read; defaults to the publisher website' }, save: { type: 'boolean' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_publisher',
    description: 'Prove the publisher runs its website (manifest token, /.well-known file, meta tag or DNS TXT). Without the token in place, returns how to add it. Needs an API key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'publish_app',
    description: 'Publish a verified, installable app to the store. Needs an API key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'feature_app',
    description:
      'Get a published app featured for $19: 7 days on the pwamart home page and a slot in the next newsletter. Returns a CoinPay crypto checkout URL for a human to pay. Needs an API key.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'get_releases',
    description: "What's new in an app: its releases (published by the developer or detected from manifest changes), newest first.",
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
  },
  {
    name: 'follow',
    description: 'Get notified when an app updates, or when a publisher ships a new app or update. Needs an API key or `pwamart login` (or pass an email for a confirmation link).',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' }, kind: { type: 'string', enum: ['app', 'publisher'] }, email: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'subscribe_newsletter',
    description: 'Subscribe an email address to the pwamart newsletter. A confirmation email is sent; nothing else is until it is tapped.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'], additionalProperties: false },
  },
];

export function installInstructions(app, platform = 'desktop') {
  const url = app.start_url ?? app.url;
  const by = {
    ios: [
      `Open ${url} in Safari, tap Share, then Add to Home Screen.`,
      `Or download the one-tap profile: ${app.profile_url}`,
    ],
    android: [`Open ${url} in Chrome and tap Install (or menu → Add to Home screen → Install).`],
    tron: [`tron --app=${url}`, 'Then `tron pwa sync` keeps the icon pointed at TronBrowser.'],
    desktop: [`npx -y @profullstack/pwamart install ${app.slug}`, `Or open ${url} in Chrome/Edge and click Install in the address bar.`],
  };
  const key = ['linux', 'macos', 'windows'].includes(platform) ? 'desktop' : platform;
  return { app: app.slug, name: app.name, url, platform, steps: by[key] ?? by.desktop, command: key === 'desktop' ? by.desktop[0] : key === 'tron' ? by.tron[0] : null };
}

const text = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** `call(path, init)` is an in-process fetch against /api/v1 carrying the caller's auth. */
export async function callTool(name, args, call, siteUrl) {
  const q = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  switch (name) {
    case 'search_apps': {
      const feature = args.feature ?? (args.offline ? 'offline' : undefined);
      const r = await call(`/apps?${q({ q: args.query, category: args.category, sort: args.sort, feature, limit: args.limit ?? 10 })}`);
      return text({
        total: r.total,
        apps: r.apps.map((a) => ({ slug: a.slug, name: a.name, summary: a.summary, publisher: a.publisher.name, category: a.category, features: a.features ?? [], rating: a.rating, installs: a.installs, url: a.start_url, page: `${siteUrl}/apps/${a.slug}` })),
      });
    }
    case 'get_app': {
      const r = await call(`/apps/${encodeURIComponent(args.slug)}`);
      return text({ ...r.app, page: `${siteUrl}/apps/${r.app.slug}`, publisher: r.publisher, reviews: r.reviews.slice(0, 5) });
    }
    case 'list_categories':
      return text((await call('/categories')).categories);
    case 'install_app': {
      const r = await call(`/apps/${encodeURIComponent(args.slug)}`);
      await call(`/apps/${encodeURIComponent(args.slug)}/installs`, json('POST', { method: 'mcp' })).catch(() => {});
      return text(installInstructions({ ...r.app, profile_url: `${siteUrl}/apps/${r.app.slug}/install.mobileconfig` }, args.platform));
    }
    case 'submit_app':
      return text(await call('/apps', json('POST', args)));
    case 'verify_app':
      return text(await call(`/apps/${encodeURIComponent(args.slug)}/verify`, json('POST')));
    case 'fill_publisher': {
      const p = `/publishers/${encodeURIComponent(args.slug)}`;
      const { suggestion } = await call(`${p}/autofill`, json('POST', args.url ? { url: args.url } : {}));
      if (!args.save) return text({ suggestion });
      const saved = await call(p, json('PATCH', { website: suggestion.website, ...(suggestion.logo && { avatar_url: suggestion.logo }), ...(suggestion.bio && { bio: suggestion.bio }) }));
      return text({ suggestion, publisher: saved.publisher });
    }
    case 'verify_publisher': {
      const p = `/publishers/${encodeURIComponent(args.slug)}`;
      try {
        return text(await call(`${p}/verify`, json('POST')));
      } catch {
        return text(await call(`${p}/manage`));
      }
    }
    case 'publish_app':
      return text(await call(`/apps/${encodeURIComponent(args.slug)}/publish`, json('POST')));
    case 'feature_app':
      return text(await call(`/apps/${encodeURIComponent(args.slug)}/feature`, json('POST')));
    case 'get_releases':
      return text(await call(`/apps/${encodeURIComponent(args.slug)}/releases`));
    case 'follow':
      return text(await call('/follow', json('POST', { kind: args.kind ?? 'app', slug: args.slug, email: args.email })));
    case 'subscribe_newsletter':
      return text(await call('/newsletter/subscribe', json('POST', { email: args.email, source: 'mcp' })));
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  }
}

export async function handleRpc(req, { call, siteUrl, version }) {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'pwamart', version },
        instructions: 'pwamart is an app store for installable web apps (PWAs). Search with search_apps, read one with get_app, and use install_app for platform steps. Publishing tools need an API key.',
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return await callTool(req.params?.name, req.params?.arguments ?? {}, call, siteUrl);
      } catch (err) {
        if (err.code === -32602) throw err;
        return text(String(err?.message ?? err), true);
      }
    case 'ping':
      return {};
    default:
      throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
  }
}
