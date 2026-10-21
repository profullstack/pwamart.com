import { describe, expect, test } from 'bun:test';
import { claudeMcpLines, installScript, mcpConfig, pick } from '../apps/web/src/collections.js';
import { cleanSurfaceSet, desktopFrom, detectSurfaces, keysOf, mergeSurfaces, rpcMessage, w3bsMatch, w3bsPage } from '../apps/web/src/surfaces.js';
import { surfaceFlags, surfaceInstructions } from '../apps/web/src/pages.js';

/** A fake origin: { 'GET /path': {status?, type?, text} }. Records what was asked. */
const site = (routes, seen = []) => async (url, opts = {}) => {
  const key = `${opts.method ?? 'GET'} ${new URL(url).pathname}`;
  seen.push(key);
  const r = routes[key];
  if (!r) return { url, status: 404, type: 'text/html', text: '<!doctype html>not found' };
  return { url, status: r.status ?? 200, type: r.type ?? 'text/plain', text: r.text };
};

const INIT_OK = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'acme', version: '1.0.0' } } });

describe('surface detection', () => {
  test('nothing but a PWA finds nothing', async () => {
    expect(await detectSurfaces({ origin: 'https://a.example', fetchFn: site({}) })).toEqual({ cli: null, api: null, mcp: null, desktop: null });
  });

  test('install.sh with a shebang is a CLI; bash scripts keep | bash; an HTML 200 is not', async () => {
    const sh = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /install.sh': { text: '#!/bin/sh\necho hi' } }) });
    expect(sh.cli).toEqual({ install: 'curl -fsSL https://a.example/install.sh | sh', script: 'https://a.example/install.sh', w3bs: null, commands: [], source: 'detected' });
    const bash = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /install.sh': { text: '#!/usr/bin/env bash\nset -e' } }) });
    expect(bash.cli.install).toBe('curl -fsSL https://a.example/install.sh | bash');
    const spa = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /install.sh': { type: 'text/html', text: '<!doctype html><div id=app>' } }) });
    expect(spa.cli).toBeNull();
  });

  test('a w3bs catalog entry wins, with its own installer, id and commands', async () => {
    const catalog = [
      { id: 'other.example/x', homepage: 'https://other.example', install: { url: 'https://other.example/i.sh', shell: 'sh' } },
      { id: 'moshcode.sh/moshcode', homepage: 'https://www.moshcode.sh', commands: ['moshcode', 'moshscript'], install: { url: 'https://moshcoding.com/install.sh', shell: 'bash' } },
    ];
    const d = await detectSurfaces({ origin: 'https://moshcode.sh', fetchFn: site({ 'GET /install.sh': { text: '#!/bin/sh' } }), catalog });
    expect(d.cli).toEqual({
      install: 'curl -fsSL https://moshcoding.com/install.sh | bash',
      script: 'https://moshcoding.com/install.sh',
      w3bs: 'moshcode.sh/moshcode',
      commands: ['moshcode', 'moshscript'],
      source: 'w3bs',
    });
    expect(w3bsMatch(catalog, 'https://nope.example')).toBeNull();
    expect(w3bsMatch([{ id: 'a.example/tool', homepage: 'https://docs.elsewhere' }], 'https://a.example').id).toBe('a.example/tool');
    expect(w3bsPage('moshcode.sh/moshcode')).toBe('https://w3bs.org/packages?q=moshcode#moshcode.sh%2Fmoshcode');
  });

  test('MCP: /mcp answering initialize (JSON or SSE), else /api/mcp, else a same-host URL from llms.txt', async () => {
    const json = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'POST /mcp': { type: 'application/json', text: INIT_OK } }) });
    expect(json.mcp).toEqual({ url: 'https://a.example/mcp', transport: 'http', name: 'acme', stdio: null, source: 'detected' });
    const sse = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'POST /api/mcp': { type: 'text/event-stream', text: `event: message\ndata: ${INIT_OK}\n\n` } }) });
    expect(sse.mcp.url).toBe('https://a.example/api/mcp');
    const seen = [];
    const named = await detectSurfaces({
      origin: 'https://a.example',
      fetchFn: site(
        {
          'GET /llms.txt': { text: '- MCP: https://a.example/v2/mcp-server (streamable HTTP)\n- Not ours: https://evil.example/mcp\n- Stdio: `npx -y @acme/acme-mcp`' },
          'POST /v2/mcp-server': { text: INIT_OK },
        },
        seen,
      ),
    });
    expect(named.mcp).toEqual({ url: 'https://a.example/v2/mcp-server', transport: 'http', name: 'acme', stdio: 'npx -y @acme/acme-mcp', source: 'detected' });
    expect(seen.some((k) => k.includes('evil'))).toBe(false);
    // A 200 that is not a JSON-RPC answer is not an MCP server.
    const page = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'POST /mcp': { type: 'text/html', text: '<!doctype html>' } }) });
    expect(page.mcp).toBeNull();
  });

  test('several catalog entries on one host: the one named after it or the app, else the origin installer', () => {
    const entries = [
      { id: 'w3bs.org/agentic-desktop-layer', homepage: 'https://w3bs.org/desktop' },
      { id: 'w3bs.org/w3bs-training', homepage: 'https://w3bs.org/training' },
    ];
    expect(w3bsMatch(entries, 'https://w3bs.org')).toBeNull();
    expect(w3bsMatch(entries, 'https://w3bs.org', 'w3bs-training').id).toBe('w3bs.org/w3bs-training');
    expect(w3bsMatch([...entries, { id: 'w3bs.org/w3bs', homepage: 'https://w3bs.org' }], 'https://w3bs.org').id).toBe('w3bs.org/w3bs');
  });

  test('a key-gated MCP endpoint counts only when llms.txt names it', async () => {
    const gated = { status: 401, type: 'application/json', text: '{"error":"unauthorized"}' };
    const named = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /llms.txt': { text: 'MCP (streamable HTTP): https://a.example/api/mcp with the same header' }, 'POST /api/mcp': gated }) });
    expect(named.mcp).toEqual({ url: 'https://a.example/api/mcp', transport: 'http', name: null, stdio: null, auth: true, source: 'detected' });
    const guessed = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'POST /api/mcp': gated }) });
    expect(guessed.mcp).toBeNull();
  });

  test('stdio only, from llms.txt', async () => {
    const d = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /llms.txt': { text: 'Stdio: `npx -y @profullstack/smshub mcp` with a key' } }) });
    expect(d.mcp).toEqual({ url: null, transport: 'stdio', name: null, stdio: 'npx -y @profullstack/smshub mcp', source: 'detected' });
  });

  test('API: an OpenAPI document, a JSON health check, or /api/ paths in llms.txt', async () => {
    const spec = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /openapi.json': { type: 'application/json', text: '{"openapi":"3.1.0","info":{}}' } }) });
    expect(spec.api).toEqual({ base: 'https://a.example/api', openapi: 'https://a.example/openapi.json', docs: 'https://a.example/openapi.json', source: 'detected' });
    const yaml = await detectSurfaces({
      origin: 'https://a.example',
      fetchFn: site({ 'GET /llms.txt': { text: '- [openapi.yaml](https://a.example/openapi.yaml)' }, 'GET /openapi.yaml': { text: 'openapi: 3.0.0\ninfo:' } }),
    });
    expect(yaml.api.openapi).toBe('https://a.example/openapi.yaml');
    const health = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /api/v1/health': { type: 'application/json', text: '{"ok":true}' } }) });
    expect(health.api).toEqual({ base: 'https://a.example/api/v1', openapi: null, docs: null, source: 'detected' });
    const notes = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /llms.txt': { text: '- GET /api/v1/things: list things' } }) });
    expect(notes.api).toEqual({ base: 'https://a.example/api/v1', openapi: null, docs: 'https://a.example/llms.txt', source: 'detected' });
    // An SPA that answers every path with its shell is not an API.
    const shell = await detectSurfaces({ origin: 'https://a.example', fetchFn: site({ 'GET /openapi.json': { type: 'text/html', text: '<!doctype html>' }, 'GET /api/v1/health': { type: 'text/html', text: '<!doctype html>' } }) });
    expect(shell.api).toBeNull();
  });

  test('desktop: the list under a Desktop heading in llms.txt, the /download link as its page', async () => {
    const llms = [
      '# nixamp',
      '- Web: https://nixamp.com',
      '## Desktop app',
      'Downloads: https://nixamp.com/download',
      '- macOS (Apple silicon): https://nixamp.com/download/mac-arm64',
      '- macOS (Intel): https://nixamp.com/download/mac-x64',
      '- Windows (x64): https://nixamp.com/download/win-x64',
      '- Linux AppImage (x86_64): https://nixamp.com/download/linux-x64',
      '- Debian/Ubuntu .deb (amd64): https://nixamp.com/download/deb-amd64.',
      '## API',
      '- Player: https://nixamp.com/download/not-desktop',
    ].join('\n');
    const d = await detectSurfaces({ origin: 'https://nixamp.com', fetchFn: site({ 'GET /llms.txt': { text: llms } }) });
    expect(d.desktop).toEqual({
      page: 'https://nixamp.com/download',
      downloads: [
        { label: 'macOS (Apple silicon)', url: 'https://nixamp.com/download/mac-arm64' },
        { label: 'macOS (Intel)', url: 'https://nixamp.com/download/mac-x64' },
        { label: 'Windows (x64)', url: 'https://nixamp.com/download/win-x64' },
        { label: 'Linux AppImage (x86_64)', url: 'https://nixamp.com/download/linux-x64' },
        { label: 'Debian/Ubuntu .deb (amd64)', url: 'https://nixamp.com/download/deb-amd64' },
      ],
      source: 'detected',
    });
  });

  test('desktop: GitHub releases count, other hosts do not, and the cap is 12', () => {
    const gh = 'https://github.com/acme/app/releases/download/v1.2.0';
    const notes = `### Desktop\n- [macOS](${gh}/App.dmg)\n- Windows: ${gh}/App-Setup.exe\n- Mirror: https://evil.example/App.dmg\n- Not releases: https://github.com/acme/app/blob/main/x.dmg\n`;
    expect(desktopFrom(notes, 'https://www.a.example')).toEqual({
      page: `${gh}/App.dmg`,
      downloads: [
        { label: 'macOS', url: `${gh}/App.dmg` },
        { label: 'Windows', url: `${gh}/App-Setup.exe` },
      ],
      source: 'detected',
    });
    // Only foreign links: nothing, not even a page.
    expect(desktopFrom('## Desktop app\n- macOS: https://evil.example/App.dmg\n- Credentials: https://u:p@a.example/x', 'https://a.example')).toBeNull();
    const many = `## Desktop\n${Array.from({ length: 20 }, (_, i) => `- Build ${i}: https://a.example/d/${i}`).join('\n')}`;
    expect(desktopFrom(many, 'https://a.example').downloads.length).toBe(12);
  });

  test('desktop: no section falls back to installer links anywhere in llms.txt', () => {
    const notes = 'Get it: https://a.example/files/App-1.0.dmg, https://a.example/files/App.AppImage and https://github.com/acme/app/releases/download/v1/app_1.0_amd64.deb\nhttps://evil.example/App.exe https://a.example/page.html';
    expect(desktopFrom(notes, 'https://a.example')).toEqual({
      page: 'https://github.com/acme/app/releases',
      downloads: [
        { label: 'macOS', url: 'https://a.example/files/App-1.0.dmg' },
        { label: 'Linux AppImage', url: 'https://a.example/files/App.AppImage' },
        { label: 'Debian/Ubuntu .deb', url: 'https://github.com/acme/app/releases/download/v1/app_1.0_amd64.deb' },
      ],
      source: 'detected',
    });
    expect(desktopFrom('just a web app https://a.example/', 'https://a.example')).toBeNull();
    expect(desktopFrom('', 'https://a.example')).toBeNull();
  });

  test('rpcMessage reads JSON and SSE bodies', () => {
    expect(rpcMessage('{"id":1}')).toEqual({ id: 1 });
    expect(rpcMessage('event: message\ndata: {"id":2}\n')).toEqual({ id: 2 });
    expect(rpcMessage('<html>')).toBeNull();
  });
});

describe('publisher corrections', () => {
  test('cleanSurfaceSet takes urls, a w3bs id, false and null', () => {
    expect(cleanSurfaceSet({ cli: { script: 'https://a.example/i.sh', w3bs: 'a.example/tool', commands: ['tool', 'bad cmd;rm'] } })).toEqual({
      cli: { install: 'curl -fsSL https://a.example/i.sh | sh', script: 'https://a.example/i.sh', w3bs: 'a.example/tool', commands: ['tool'], source: 'publisher' },
    });
    expect(cleanSurfaceSet({ cli: { install: 'curl -fsSL https://a.example/i.sh | bash' } }).cli.install).toBe('curl -fsSL https://a.example/i.sh | bash');
    expect(cleanSurfaceSet({ mcp: { url: 'https://a.example/mcp' }, api: false, cli: null })).toEqual({
      mcp: { url: 'https://a.example/mcp', transport: 'http', name: null, stdio: null, source: 'publisher' },
      api: false,
      cli: null,
    });
    expect(cleanSurfaceSet({ api: { base: 'https://a.example/api/v1/' } }).api.base).toBe('https://a.example/api/v1');
  });

  test('cleanSurfaceSet takes a desktop page and downloads, https only', () => {
    expect(cleanSurfaceSet({ desktop: { page: 'https://a.example/download', downloads: [{ label: ' macOS\n(arm64) ', url: 'https://a.example/App.dmg' }, { url: 'https://a.example/App.exe' }] } })).toEqual({
      desktop: {
        page: 'https://a.example/download',
        downloads: [
          { label: 'macOS (arm64)', url: 'https://a.example/App.dmg' },
          { label: 'App.exe', url: 'https://a.example/App.exe' },
        ],
        source: 'publisher',
      },
    });
    expect(cleanSurfaceSet({ desktop: false, cli: null })).toEqual({ desktop: false, cli: null });
    expect(() => cleanSurfaceSet({ desktop: {} })).toThrow();
    expect(() => cleanSurfaceSet({ desktop: { page: 'http://a.example/download' } })).toThrow();
    expect(() => cleanSurfaceSet({ desktop: { page: 'https://u:p@a.example/download' } })).toThrow();
    expect(() => cleanSurfaceSet({ desktop: { downloads: [{ label: 'x', url: 'javascript:alert(1)' }] } })).toThrow();
    expect(() => cleanSurfaceSet({ desktop: { downloads: 'https://a.example/App.dmg' } })).toThrow();
  });

  test('cleanSurfaceSet refuses anything that would become an unsafe command', () => {
    expect(() => cleanSurfaceSet({ cli: { script: 'http://a.example/i.sh' } })).toThrow();
    expect(() => cleanSurfaceSet({ cli: { install: 'curl https://a.example | sudo sh' } })).toThrow();
    expect(() => cleanSurfaceSet({ cli: { w3bs: 'not an id; rm -rf /' } })).toThrow();
    expect(() => cleanSurfaceSet({ mcp: { stdio: 'npx -y x; curl evil | sh' } })).toThrow();
    expect(() => cleanSurfaceSet({ api: { base: 'javascript:alert(1)' } })).toThrow();
    expect(() => cleanSurfaceSet({ tui: {} })).toThrow();
    expect(() => cleanSurfaceSet([1])).toThrow();
  });

  test('the publisher wins key by key; false hides; pwa is always there', () => {
    const detected = { cli: { install: 'curl -fsSL https://a.example/install.sh | sh', script: 'https://a.example/install.sh' }, api: { base: 'https://a.example/api' }, mcp: null };
    const merged = mergeSurfaces(detected, { api: false, mcp: { url: 'https://a.example/mcp' }, cli: { w3bs: 'a.example/a' } });
    expect(merged.pwa).toBe(true);
    expect(merged.api).toBeNull();
    expect(merged.mcp.url).toBe('https://a.example/mcp');
    expect(merged.cli).toEqual({ install: 'curl -fsSL https://a.example/install.sh | sh', script: 'https://a.example/install.sh', w3bs: 'a.example/a' });
    expect(keysOf(merged)).toEqual(['pwa', 'cli', 'mcp']);
    const desk = mergeSurfaces({ desktop: { page: 'https://a.example/download', downloads: [{ label: 'macOS', url: 'https://a.example/m' }] } }, { desktop: { page: 'https://a.example/get' } });
    expect(desk.desktop).toEqual({ page: 'https://a.example/get', downloads: [{ label: 'macOS', url: 'https://a.example/m' }] });
    expect(keysOf(desk)).toEqual(['pwa', 'desktop']);
    expect(keysOf(mergeSurfaces(desk, { desktop: false }))).toEqual(['pwa']);
    expect(keysOf(mergeSurfaces())).toEqual(['pwa']);
  });
});

describe('collections', () => {
  const apps = [
    { slug: 'one', name: 'One', surfaces: { pwa: true, cli: { install: 'curl -fsSL https://one.example/install.sh | sh', script: 'https://one.example/install.sh' }, mcp: { url: 'https://one.example/mcp' } } },
    { slug: 'two', name: 'Two', surfaces: { pwa: true, cli: { install: 'curl -fsSL https://two.example/install.sh | bash', script: 'https://two.example/install.sh' }, mcp: { url: null, stdio: 'npx -y two-mcp' } } },
    { slug: 'evil', name: 'Evil', surfaces: { pwa: true, cli: { script: "https://e.example/x.sh'; rm -rf ~; '" } } },
    { slug: 'pwa-only', name: 'Plain', surfaces: { pwa: true } },
  ];
  const col = { slug: 'kit', title: 'Kit' };

  test('install.sh runs each safe installer with its shell and never a quoted URL', () => {
    const s = installScript(col, apps, 'https://pwamart.com');
    expect(s.startsWith('#!/bin/sh\n')).toBe(true);
    expect(s).toContain("run 'one' 'https://one.example/install.sh' sh");
    expect(s).toContain("run 'two' 'https://two.example/install.sh' bash");
    expect(s).not.toContain('rm -rf');
    expect(s).toContain('of 2 installed');
    expect(installScript(col, [apps[3]], 'https://pwamart.com')).toContain('No app in this collection has a CLI yet');
  });

  test('install.sh is valid sh', async () => {
    const proc = Bun.spawn(['sh', '-n'], { stdin: new Blob([installScript(col, apps, 'https://pwamart.com')]) });
    expect(await proc.exited).toBe(0);
  });

  test('mcp.json and claude mcp add lines', () => {
    expect(mcpConfig(apps)).toEqual({ mcpServers: { one: { type: 'http', url: 'https://one.example/mcp' }, two: { command: 'npx', args: ['-y', 'two-mcp'] } } });
    expect(claudeMcpLines(apps)).toEqual(['claude mcp add --transport http one https://one.example/mcp', 'claude mcp add two -- npx -y two-mcp']);
  });

  test('?apps= narrows to members only, and an empty or foreign list means all', () => {
    expect(pick(apps, 'two,nope').map((a) => a.slug)).toEqual(['two']);
    expect(pick(apps, 'nope').length).toBe(4);
    expect(pick(apps, '').length).toBe(4);
  });
});

describe('surface pages', () => {
  const app = {
    slug: 'acme',
    name: 'Acme',
    surfaces: {
      pwa: true,
      cli: { install: 'curl -fsSL https://acme.example/install.sh | sh', script: 'https://acme.example/install.sh', w3bs: 'acme.example/acme', w3bs_url: w3bsPage('acme.example/acme'), w3bs_install: 'w3bs install acme.example/acme', commands: ['acme'] },
      mcp: { url: 'https://acme.example/mcp' },
      api: null,
      desktop: { page: 'https://acme.example/download', downloads: [{ label: 'macOS <arm64>', url: 'https://acme.example/download/mac' }, { label: 'bad', url: 'javascript:alert(1)' }] },
    },
  };

  test('flags show every surface on the details page and only the real ones on cards', () => {
    expect(surfaceFlags(app)).toContain('s-cli');
    expect(surfaceFlags(app)).not.toContain('s-api');
    expect(surfaceFlags(app, { all: true })).toContain('s-api off');
  });

  test('instructions cover the CLI, w3bs and MCP, and tell the publisher what is missing', () => {
    const h = surfaceInstructions(app);
    expect(h).toContain('curl -fsSL https://acme.example/install.sh | sh');
    expect(h).toContain('w3bs install acme.example/acme');
    expect(h).toContain('w3bs.org/packages');
    expect(h).toContain('claude mcp add --transport http acme https://acme.example/mcp');
    expect(h).toContain('No API found');
    expect(h).toContain('<a href="https://acme.example/download" rel="noopener nofollow" target="_blank">Download the desktop app');
    expect(h).toContain('macOS &lt;arm64&gt;');
    expect(h).not.toContain('javascript:');
    expect(surfaceFlags(app)).toContain('s-desktop');
  });
});
