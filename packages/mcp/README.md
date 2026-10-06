# @profullstack/pwamart-mcp

MCP server for [pwamart](https://pwamart.com), the app store for web apps.

```sh
claude mcp add pwamart -- npx -y @profullstack/pwamart-mcp
```

Or use the hosted endpoint with no install: `https://pwamart.com/mcp` (streamable HTTP).

| Tool | Needs a key |
| --- | --- |
| `search_apps` | no |
| `get_app` | no |
| `list_categories` | no |
| `install_app`: steps and command for ios, android, desktop, linux, macos, windows, tron | no |
| `submit_app`, `verify_app`, `publish_app` | `PWAMART_API_KEY` |

`PWAMART_URL` points it at another server.
