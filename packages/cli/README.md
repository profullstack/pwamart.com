# @profullstack/pwamart

[pwamart](https://pwamart.com), the app store for web apps, from the terminal.

```sh
curl -fsSL https://pwamart.com/install.sh | sh     # or: npm i -g @profullstack/pwamart

pwamart search notes
pwamart browse --offline    # only apps whose service worker works offline
pwamart search --surface mcp   # apps that are also an MCP server (or cli, api, desktop)
pwamart collections [slug]  # agentic workflow collections: one curl | sh installs every CLI
pwamart info <slug>
pwamart install <slug>      # opens it as an app window, writes a launcher entry (Linux)
pwamart tui                 # the whole store in your terminal, on hqtui
```

`install` uses TronBrowser (`tron --app=…`) when it is installed, otherwise Chrome, Chromium,
Edge or Brave in app mode. Set `PWAMART_BROWSER` to pick one.

## Publish

```sh
pwamart login pm_live_...                 # key from https://pwamart.com/console/keys
pwamart publisher "Acme Apps"
pwamart check https://your.app            # grade installability
pwamart submit https://your.app --publisher acme-apps
pwamart verify <slug> && pwamart publish <slug>
pwamart surfaces <slug> --cli https://your.app/install.sh --mcp https://your.app/mcp
```

## Karma

Upvote, review, comment on and share apps (and publish your own) to earn karma; every 500 is a
free Featured week. Same points as built.indie.

```sh
pwamart karma                              # total, rank, badges, free weeks, history, how to earn
pwamart leaderboard --period week          # or month, all
pwamart vote <slug>                        # --remove takes it back
pwamart review <slug> --rating 5 --text "Installs in one tap and works offline."
pwamart comment <slug> "Does it sync?"     # --reply <id>; pwamart comments <slug>
pwamart feature <slug> --credit            # spend a free Featured week
```

In the TUI, `u` upvotes the selected app and `l` shows the karma board.

Environment: `PWAMART_API_KEY`, `PWAMART_URL`, `PWAMART_BROWSER`.

As a library: `@profullstack/pwamart/client` (the API), `/install` (app-window installer), `/tui`.
