# pwamart

**The app store for Progressive Web Apps.** pwamart lists installable web apps and installs
them on iPhone, Android, macOS, Windows and Linux, from a browser, a terminal, a desktop app,
TronBrowser or an AI agent. No app store review, no 30% cut, no rooting.

Live at **https://pwamart.com**.

| Surface | How |
| --- | --- |
| Web + PWA | https://pwamart.com: store, details pages with an Install button, the publisher console |
| API | `https://pwamart.com/api/v1`, see [llms.txt](https://pwamart.com/llms.txt) |
| MCP | hosted `POST https://pwamart.com/mcp`, or `npx -y @profullstack/pwamart-mcp` |
| CLI | `curl -fsSL https://pwamart.com/install.sh \| sh` then `pwamart search` / `install` / `submit` |
| TUI | `pwamart tui`, built on [hqtui](https://hqtui.com) |
| Desktop | `apps/desktop` (Electron), installers on each GitHub release |
| TronBrowser | installs open as `tron --app=<url>` windows; the details page detects TronBrowser |

## What Install does

A store cannot press another site's install button, so each surface does the most it can:

- **Web Install API** (`navigator.install`) where the browser ships it: one click.
- **iPhone/iPad:** Add to Home Screen steps, or a one-tap `.mobileconfig` web-clip profile
  (`/apps/<slug>/install.mobileconfig`, or several at once with `/bundle.mobileconfig?apps=a,b`).
- **Android, desktop Chrome/Edge/Brave, Safari, Firefox:** the exact taps for that browser.
- **CLI, TUI, desktop app:** open the app as its own window (TronBrowser first, then Chrome,
  Chromium, Edge, Brave) and write a launcher entry with its icon.

## Publishing

Submit a URL; the inspector reads the manifest and grades installability. Prove you own the
origin (a `.well-known/pwamart.txt` file, a `<meta name="pwamart-verification">` tag, or a
`_pwamart` DNS TXT record), then publish.

| Plan | Price | Publishers | Apps |
| --- | --- | --- | --- |
| Free | $0 | 1 | 10 |
| Pro | $10/year | 10 | 100 |
| Unlimited | $199/year | unlimited | unlimited, plus shared orgs, teams and projects |

Limits count every org the account created. Payments go through CoinPay; a settled payment
adds a year. A lapsed plan never hides a live listing.

## Layout

```
apps/web        Bun + Hono: pages, /api/v1, /mcp, console SPA (public/console), inspector
apps/desktop    Electron desktop app (not in the Docker image)
packages/cli    @profullstack/pwamart: CLI, hqtui TUI, API client, installer
packages/mcp    @profullstack/pwamart-mcp: stdio server + the tool core the web /mcp uses
packages/db     postgres client + forward-only migrations (run on every boot)
packages/payments  the shared CoinPay module (copied verbatim between brands)
bin/seed-fleet.mjs  lists Profullstack's own PWAs (staff key)
```

## Develop

```sh
bun install
DATABASE_URL=postgres://... bun run dev     # http://localhost:3000
DATABASE_URL=postgres://... bun test        # unit + end to end (skips e2e without a DB)
```

Deploys: every push to `master` ships to dev2 (`deploy-dev2.yml`). Secrets live in the
logicsrc vault `pwamart--prod`. Releases: bump `version` in `packages/cli` and `packages/mcp`
and merge; `release.yml` publishes both to npm, tags, and attaches desktop installers.

MIT © Profullstack, Inc.
