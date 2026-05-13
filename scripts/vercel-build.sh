#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel `buildCommand` entry point.
#
# Pairs with scripts/vercel-install.sh. The install phase bootstraps
# rustup at Vercel's pre-set RUSTUP_HOME=/rust, but those environment
# variables don't propagate to this phase by default — `rustup run`
# from turbo subprocesses falls back to ~/.rustup, finds nothing, and
# reports "toolchain not installed" (observed on iad1 in the first
# deploys of fix/issue-654-catia-header-hash).
#
# Re-export the same locations here so every subprocess turbo spawns
# (wasm-pack, cargo, rustup run …) sees a consistent toolchain location.
# Note: NOT using `set -e` here. The diagnostic command -v probes below
# can return non-zero (e.g. when wasm-pack isn't on PATH yet because the
# install script's PATH export didn't carry over), and we want the script
# to continue and let turbo emit its own clearer error rather than dying
# silently inside a command substitution.
set -uo pipefail

# Vercel's build image pre-installs rustup under /rust. Local CI / GHA
# uses ~/.cargo + ~/.rustup. Set both prefixes; the second one wins
# silently if /rust isn't there. Either way `command -v rustup` finds
# the binary on PATH and `rustup run` finds the toolchain in HOME.
if [ -d "/rust" ]; then
  export RUSTUP_HOME="/rust"
  export CARGO_HOME="/rust"
  export PATH="/rust/bin:$PATH"
fi

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:$PATH"

echo "🏗️  Vercel build phase"
echo "   HOME=$HOME  PWD=$PWD"
RUSTUP_BIN=$(command -v rustup 2>/dev/null || true)
CARGO_BIN=$(command -v cargo 2>/dev/null || true)
WASM_PACK_BIN=$(command -v wasm-pack 2>/dev/null || true)
echo "   rustup:    ${RUSTUP_BIN:-MISSING}"
echo "   cargo:     ${CARGO_BIN:-MISSING}"
echo "   wasm-pack: ${WASM_PACK_BIN:-MISSING}"
echo "   RUSTUP_HOME=${RUSTUP_HOME:-<unset>}"
echo "   CARGO_HOME=${CARGO_HOME:-<unset>}"
echo "   PATH=$PATH"

# Filter passed by caller (defaults to the main viewer app). Each Vercel
# project supplies its own filter so the same script powers both
# apps/viewer and apps/viewer-embed.
FILTER="${1:-@ifc-lite/viewer...}"
echo "   filter:    $FILTER"
exec npx turbo build --filter="$FILTER"
