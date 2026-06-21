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

# Park cargo's target/ in Vercel's persistent build-cache mount so
# incremental Rust compiles survive across deploys. Vercel preserves
# the contents of `/vercel/cache/` between successive builds of the
# same project. Falls back to the workspace's default ./target when
# the directory isn't writable (local CI runners, GHA, etc.).
if mkdir -p "/vercel/cache/cargo-target" 2>/dev/null; then
  export CARGO_TARGET_DIR="/vercel/cache/cargo-target"
  echo "🦀 CARGO_TARGET_DIR=$CARGO_TARGET_DIR (persistent across Vercel deploys)"
else
  echo "🦀 CARGO_TARGET_DIR unset (no writable Vercel cache dir; using ./target)"
fi

# Surface Turbo Remote Cache status in the deploy log. Cache hits show
# up as "FULL TURBO" in turbo's banner; if you don't see them, set
# TURBO_TEAM + TURBO_TOKEN in the Vercel project env.
if [ -n "${TURBO_TOKEN:-}" ] && [ -n "${TURBO_TEAM:-}" ]; then
  echo "🚀 Turbo Remote Cache enabled (team=$TURBO_TEAM)"
else
  echo "⚠️  Turbo Remote Cache NOT configured — every deploy will rebuild WASM from source."
  echo "   Set TURBO_TEAM + TURBO_TOKEN in the Vercel project env to enable."
fi

# WASM build memory: the release profile uses FAT LTO (whole-program link held
# in memory) when wasm-pack compiles ifc-lite-wasm from source. On a rust-touching
# branch (no Turbo cache hit) that OOMs Vercel's 8 GB build container, which
# silently drops the static SPA → the deploy is READY but every route 404s.
# THIN LTO removes the whole-program link and fixes the OOM on its own; do NOT
# also raise codegen-units (it measurably slows the exact-CSG hot path — less
# cross-unit inlining — enough to trip the viewer's 40s geometry-stream watchdog
# on heavy models, see 29954270). Keep the profile's codegen-units=1. Vercel-only:
# this script doesn't run for main's prebuilt-WASM path, the npm bundle, or local/
# CI builds. `:-` so an explicit Vercel project env can still override.
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-thin}"
echo "🦀 Vercel WASM build: LTO=$CARGO_PROFILE_RELEASE_LTO codegen-units=1 (thin-LTO fixes the build-container OOM; codegen-units stays 1 for runtime CSG speed)"

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

npx turbo build --filter="$FILTER"
build_status=$?

# --- Vercel Skew Protection -------------------------------------------------
# Pin each browser session to the deployment that served it so lazily-fetched,
# content-hashed assets (notably the geometry WASM, fetched only when a model is
# opened) don't 404 after a newer deploy ships fresh hashes — the cause of the
# production "Failed to execute 'compile' on 'WebAssembly': HTTP status code is
# not ok" error. apps/viewer/index.html ships a __VDPL_DEPLOYMENT_ID__ token; we
# substitute the live deployment id here.
#
# This runs AFTER turbo (not as a turbo task) on purpose: the value is correct
# even on a FULL TURBO cache hit, because the cached dist/index.html still holds
# the literal token and we replace it outside turbo's cache. It only fires when
# the project's Skew Protection toggle is on (VERCEL_SKEW_PROTECTION_ENABLED=1);
# otherwise the token is left untouched and the in-page guard is a no-op.
if [ "$build_status" -eq 0 ] && [ "${VERCEL_SKEW_PROTECTION_ENABLED:-}" = "1" ] && [ -n "${VERCEL_DEPLOYMENT_ID:-}" ]; then
  injected=0
  for html in apps/*/dist/index.html; do
    [ -f "$html" ] || continue
    if grep -q "__VDPL_DEPLOYMENT_ID__" "$html"; then
      sed -i.bak "s/__VDPL_DEPLOYMENT_ID__/${VERCEL_DEPLOYMENT_ID}/g" "$html" && rm -f "$html.bak"
      echo "🔒 Skew Protection: injected $VERCEL_DEPLOYMENT_ID into $html"
      injected=1
    fi
  done
  [ "$injected" -eq 0 ] && echo "ℹ️  Skew Protection enabled but no __VDPL_DEPLOYMENT_ID__ token found to inject."
else
  echo "ℹ️  Skew Protection: __VDPL_DEPLOYMENT_ID__ left unreplaced (toggle off or no deployment id)."
fi

exit $build_status
