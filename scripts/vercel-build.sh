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

# ── PostHog source maps ─────────────────────────────────────────────────────
# Production stack traces are unreadable without them: every frame in error
# tracking reads "Could not find sourcemap for source url", so diagnosing a
# crash has meant hand-fetching the deployed bundle from its immutable
# deployment URL and decoding line/column by hand.
#
# Strictly opt-in: map generation costs build time + memory, and this builder is
# tight enough that the WASM link has OOM'd it before. So we only turn it on
# when a CLI key is actually present, i.e. only when the maps will be uploaded
# and then deleted. With no key, nothing changes from today's build at all.
#
# Required Vercel project env to enable:
#   POSTHOG_CLI_API_KEY   personal API key (phx_...) with
#                         `error tracking write` + `organization read` scopes
#                         -> https://eu.posthog.com/settings/user-api-keys
#   POSTHOG_CLI_ENV_ID    PostHog project id (199147)
#   POSTHOG_CLI_HOST      https://eu.posthog.com   (EU cloud)
if [ -n "${POSTHOG_CLI_API_KEY:-}" ]; then
  export VITE_SOURCEMAP=1
  echo "🗺️  Source maps ENABLED (POSTHOG_CLI_API_KEY present) — will upload then delete"
else
  echo "🗺️  Source maps disabled (no POSTHOG_CLI_API_KEY) — traces stay minified"
fi

npx turbo build --filter="$FILTER"
build_status=$?

# Upload + strip. `sourcemap process` injects a chunk id, uploads, and with
# --delete-after removes the .map files AND strips the sourceMappingURL
# comments, so maps are never served to users. Release version is the same
# 12-char sha the viewer stamps on every event as `app_build_sha`, so symbol
# sets line up with the events they symbolicate.
#
# Never fails the deploy: symbolication is diagnostics, not correctness. But we
# ALWAYS sweep leftover maps out of the output afterwards — a failed upload must
# not silently publish them.
OUT_DIR="apps/viewer/dist"
if [ $build_status -eq 0 ] && [ -n "${POSTHOG_CLI_API_KEY:-}" ] && [ -d "$OUT_DIR" ]; then
  # This repo builds with rolldown-vite, which emits the .map files but NOT the
  # trailing `//# sourceMappingURL=` comment. posthog-cli documents that it
  # locates maps via that comment (see its --public-path-prefix flag: "we need
  # to ignore it while searching for them"), so add the comment for any chunk
  # that has a sibling map. Pairing is then guaranteed by construction instead
  # of relying on an unverified filename-convention fallback. `--delete-after`
  # strips these comments again after upload, so nothing ships with a dangling
  # reference.
  node scripts/add-sourcemap-refs.mjs "$OUT_DIR"
  RELEASE_VERSION="$(printf '%.12s' "${VERCEL_GIT_COMMIT_SHA:-${GITHUB_SHA:-dev}}")"
  echo "🗺️  Uploading source maps (release ${RELEASE_VERSION})…"
  pnpm exec posthog-cli sourcemap process \
    --directory "$OUT_DIR" \
    --release-name ifc-lite-viewer \
    --release-version "$RELEASE_VERSION" \
    --delete-after || echo "⚠️  Source-map upload failed — continuing (deploy is unaffected)"
fi

# Belt and braces: whatever happened above, no .map may reach the CDN.
if [ -d "$OUT_DIR" ]; then
  leftover=$(find "$OUT_DIR" -name '*.map' -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$leftover" != "0" ]; then
    echo "🗺️  Removing $leftover source map(s) from the output (not for public serving)"
    find "$OUT_DIR" -name '*.map' -type f -delete 2>/dev/null || true
    # The maps are gone, so any surviving reference now points at nothing and
    # would 404 for anyone with devtools open. Strip them (this only runs when
    # the upload did not, since --delete-after already removes both).
    node scripts/add-sourcemap-refs.mjs "$OUT_DIR" --strip || true
  fi
fi

# NOTE: A previous client-side Vercel Skew Protection pin (a __vdpl cookie set
# from apps/viewer/index.html, with the live deployment id substituted here at
# deploy time) was REMOVED in #1457. It routed content-hashed asset requests to a
# stale-pinned deployment, so returning browsers (Edge/Brave) 404'd on every
# /assets/* after an asset-hash-rotating deploy and the app never booted. The
# lazy-WASM-404 case it targeted is handled in app code (@ifc-lite/geometry
# wasm-asset-error + apps/viewer wasm-version-skew). To fully retire the pin,
# also turn OFF the project's Skew Protection toggle so the platform stops
# honoring any __vdpl cookie still held by clients.

exit $build_status
