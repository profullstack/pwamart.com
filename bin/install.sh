#!/bin/sh
# pwamart installer, upgrader and remover. Never asks for root.
#
#   curl -fsSL https://pwamart.com/install.sh   | sh          install (or upgrade)
#   curl -fsSL https://pwamart.com/upgrade.sh   | sh          upgrade to the latest
#   curl -fsSL https://pwamart.com/uninstall.sh | sh          remove the CLI
#   ... | sh -s -- --uninstall --purge                        also delete sign-in, config,
#                                                              icons and app launchers
#
# Installs the CLI + TUI (@profullstack/pwamart) with bun or npm, pinned to the
# registry's exact latest version (a bare @latest can come from a package
# manager's cache). After install: `pwamart login` signs in through the browser
# (OAuth 2.1); the TUI and the MCP server share that sign-in.
# Desktop app: https://github.com/profullstack/pwamart.com/releases
set -eu
PKG=@profullstack/pwamart
MODE=${PWAMART_MODE:-install}
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --upgrade|--update|upgrade|update) MODE=upgrade ;;
    --uninstall|--remove|uninstall|remove) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done
say() { printf '%s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pwamart"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"

current() { pwamart version 2>/dev/null || true; }

if [ "$MODE" = uninstall ]; then
  was=$(current)
  removed=0
  if have bun && bun pm ls -g 2>/dev/null | grep -q "$PKG"; then bun remove -g "$PKG" && removed=1; fi
  if have npm && npm ls -g "$PKG" >/dev/null 2>&1; then npm uninstall -g "$PKG" && removed=1; fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$CONFIG_DIR" "$DATA_DIR/pwamart"
    rm -f "$DATA_DIR"/applications/pwamart-*.desktop
    have update-desktop-database && update-desktop-database "$DATA_DIR/applications" 2>/dev/null || true
    say "Removed sign-in, config, icons and app launchers."
  fi
  if [ "$removed" = 1 ]; then say "pwamart ${was:-} removed."; else say "pwamart was not installed globally (nothing to remove)."; fi
  [ "$PURGE" = 1 ] || say "Your sign-in and installed app launchers were kept; add --purge to delete them too."
  exit 0
fi

VERSION=$(curl -fsSL "https://registry.npmjs.org/$PKG/latest" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$VERSION" ] || { say "could not read the latest $PKG version from npm"; exit 1; }
was=$(current)
if [ "$MODE" = upgrade ] && [ "$was" = "$VERSION" ]; then
  say "pwamart $VERSION is already the latest."
  exit 0
fi
if have bun; then
  bun add -g "$PKG@$VERSION"
elif have npm; then
  npm install -g "$PKG@$VERSION"
else
  say "Installing bun first (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  "$HOME/.bun/bin/bun" add -g "$PKG@$VERSION"
  say "Add ~/.bun/bin to your PATH if pwamart is not found."
fi
if [ -n "$was" ] && [ "$was" != "$VERSION" ]; then
  say "pwamart upgraded: $was -> $VERSION"
else
  say "pwamart $VERSION installed."
fi
say "Next: pwamart login   (or pwamart search, pwamart tui)"
