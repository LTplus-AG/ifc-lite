#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel "Ignored Build Step" entry point.
#
# Paste this script's path into the Vercel project's
#   Settings → Git → Ignored Build Step
# field:
#
#   bash scripts/vercel-ignore-build.sh
#
# Vercel runs the script for every push. Per the Vercel docs:
#
#   exit 0  → skip the deploy (no build minutes charged)
#   exit 1  → run the deploy as normal
#   any other → run the deploy as normal
#
# We skip when the commit changes nothing the viewer build cares about:
# no Rust source, no Cargo manifests, no rust-toolchain pin, no
# package manifests, no build/CI scripts, no viewer/renderer/wasm code,
# no shared package code, no Vite/Turbo config. The default decision
# when in doubt is to DEPLOY (exit 1), so this is conservative — a
# false negative wastes a build, a false positive ships a stale viewer.
#
# Pairs with Turbo Remote Cache (see scripts/README-vercel-cost.md):
# Turbo handles per-task cache hits when something Rust-adjacent
# changed; this script handles the no-op-change case where Turbo
# would otherwise still spin up a fresh Vercel build container only
# to find every task cached.
set -uo pipefail

# Vercel exposes the commit being built and its parent. Use the parent
# pointer that Vercel sets (`VERCEL_GIT_PREVIOUS_SHA`) when available
# — for production deploys this points at the previous *successful*
# production deploy's commit, which is what we want to compare against.
# Fall back to HEAD^ for branch/preview deploys with no previous.
BASE="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
HEAD_SHA="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

echo "🔍 Vercel ignored-build-step check"
echo "   BASE=$BASE  HEAD=$HEAD_SHA"

# `git diff --quiet` returns 0 when there are no changes matching the
# pathspec, 1 when there are. We want to *skip* the build only when
# every pathspec returns 0 (no relevant changes).
RELEVANT=(
  # Rust sources + manifests + lockfile (anything Rust-adjacent rebuilds WASM)
  'Cargo.toml'
  'Cargo.lock'
  'rust-toolchain.toml'
  'rust/**'
  # Build scripts that influence either the install or build phase.
  'scripts/build-wasm.sh'
  'scripts/vercel-build.sh'
  'scripts/vercel-install.sh'
  'scripts/run-build-wasm.mjs'
  'scripts/fetch-prebuilt-wasm.mjs'
  # Anything that participates in the viewer bundle.
  'apps/viewer/**'
  'apps/viewer-embed/**'
  'packages/**/src/**'
  'packages/**/package.json'
  'packages/wasm/**'
  'packages/wasm-threaded/**'
  # Workspace + tooling config.
  'package.json'
  'pnpm-lock.yaml'
  'pnpm-workspace.yaml'
  'turbo.json'
  'tsconfig.json'
  'tsconfig.packages.json'
  'vercel.json'
)

if git diff --quiet "$BASE" "$HEAD_SHA" -- "${RELEVANT[@]}"; then
  echo "✅ No relevant changes — skipping deploy."
  exit 0
fi

echo "🚀 Relevant changes detected — proceeding with deploy."
echo "   (Turbo Remote Cache will skip individual tasks if their inputs are unchanged.)"
exit 1
