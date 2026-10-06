# @profullstack/pwamart

[pwamart](https://pwamart.com), the app store for web apps, from the terminal.

```sh
curl -fsSL https://pwamart.com/install.sh | sh     # or: npm i -g @profullstack/pwamart

pwamart search notes
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
```

Environment: `PWAMART_API_KEY`, `PWAMART_URL`, `PWAMART_BROWSER`.

As a library: `@profullstack/pwamart/client` (the API), `/install` (app-window installer), `/tui`.
