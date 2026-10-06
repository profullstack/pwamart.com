#!/bin/sh
# pwamart installer: curl -fsSL https://pwamart.com/install.sh | sh
# Installs the pwamart CLI + TUI (@profullstack/pwamart) with bun or npm, pinned to
# the registry's exact latest version (a bare @latest can be served from a package
# manager's cache). Never asks for root. For the desktop app see
# https://github.com/profullstack/pwamart.com/releases
set -eu
PKG=@profullstack/pwamart
say() { printf '%s\n' "$*" >&2; }
VERSION=$(curl -fsSL "https://registry.npmjs.org/$PKG/latest" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$VERSION" ] || { say "could not read the latest $PKG version from npm"; exit 1; }
if command -v bun >/dev/null 2>&1; then
  bun add -g "$PKG@$VERSION"
elif command -v npm >/dev/null 2>&1; then
  npm install -g "$PKG@$VERSION"
else
  say "Installing bun first (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash
  "$HOME/.bun/bin/bun" add -g "$PKG@$VERSION"
  say "Add ~/.bun/bin to your PATH if pwamart is not found."
fi
say "pwamart $VERSION installed. Try: pwamart search   or   pwamart tui"
