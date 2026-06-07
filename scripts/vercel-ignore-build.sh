#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel "Ignored Build Step" entry point — PROJECT-SCOPED.
#
# Set this as each Vercel project's
#   Settings → Git → Ignored Build Step
# command, passing the scope for that project:
#
#   ifc-lite (viewer)        →  bash scripts/vercel-ignore-build.sh viewer
#   ifc-lite-viewer-embed    →  bash scripts/vercel-ignore-build.sh embed
#   ifc-lite-dev (landing)   →  bash scripts/vercel-ignore-build.sh landing
#
# Why per-scope: all three projects are wired to the same repo, so by
# default EVERY push deploys ALL of them (Vercel monorepo default). The
# heavy viewer / viewer-embed projects each compile Rust + WASM from
# source (rust toolchain + emsdk + cargo, several minutes), and the
# landing page is a static no-op build — yet a pure-geometry Rust PR was
# rebuilding the landing, and a landing copy-edit was spinning up the
# viewer. Scoping each project to the paths it actually consumes is the
# single biggest Vercel build-minute lever for this repo.
# See scripts/README-vercel-cost.md for the full cost rationale.
#
# Vercel runs the script for every push. Per the Vercel docs:
#
#   exit 0  → skip the deploy (no build minutes charged)
#   exit 1  → run the deploy as normal
#   any other → run the deploy as normal
#
# The default decision when in doubt is to DEPLOY (exit 1), so this is
# conservative — a false negative wastes a build, a false positive ships
# a stale deploy.
#
# Pairs with Turbo Remote Cache (auto-enabled on Vercel builds): Turbo
# handles per-task cache hits when something relevant changed; this
# script handles the no-op case where Vercel would otherwise spin up a
# fresh build container only to find every task cached (or nothing to do).
set -uo pipefail

# Scope selects which paths count as "relevant" for this project.
# Defaults to `viewer` so the historical no-arg command keeps working.
SCOPE="${1:-viewer}"

# Run from the git repo root so the pathspecs below resolve correctly no
# matter which Root Directory a Vercel project sets — Vercel invokes the
# Ignored Build Step from the project's Root Directory, and the embed
# project's root is `apps/viewer-embed`, not the repo root. Fall back to the
# current dir if we're somehow not in a git work tree (git diff then fails
# closed → DEPLOY, the safe default).
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || true

# Pick the commit to diff against. `VERCEL_GIT_PREVIOUS_SHA` (the previous
# successful deploy) is the most accurate base, BUT it usually points at a
# commit that ISN'T in Vercel's shallow clone — `git diff` then dies with
# "fatal: bad object <sha>", the check fails, and we deploy every time
# (never skipping). So only use it when it's actually present in the clone;
# otherwise fall back to HEAD^, which the shallow clone does include.
BASE="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$BASE" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  BASE="HEAD^"
fi
HEAD_SHA="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
# Guard HEAD_SHA too: if Vercel's SHA isn't in the clone, use the literal HEAD.
git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null || HEAD_SHA="HEAD"

# Shared inputs every Rust+WASM app (viewer, viewer-embed) depends on.
# The landing page is static and depends on NONE of these.
COMMON=(
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
  # Shared workspace packages consumed by both apps.
  'packages/**/src/**'
  'packages/**/package.json'
  'packages/wasm/**'
  # Workspace + tooling config.
  'package.json'
  'pnpm-lock.yaml'
  'pnpm-workspace.yaml'
  'turbo.json'
  'tsconfig.json'
  'tsconfig.packages.json'
  'vercel.json'
)

case "$SCOPE" in
  viewer)
    RELEVANT=("${COMMON[@]}" 'apps/viewer/**')
    ;;
  embed)
    RELEVANT=("${COMMON[@]}" 'apps/viewer-embed/**')
    ;;
  landing)
    # Static landing page (apps/landing): plain HTML/CSS/JS, no deps, no
    # compile. It depends ONLY on its own files — never on Rust/WASM or
    # the shared packages — so it must NOT rebuild on viewer/geometry PRs.
    RELEVANT=('apps/landing/**')
    ;;
  *)
    echo "❌ Unknown scope '$SCOPE' (expected: viewer | embed | landing)." >&2
    echo "   Defaulting to DEPLOY to stay safe." >&2
    exit 1
    ;;
esac

echo "🔍 Vercel ignored-build-step check (scope=$SCOPE)"
echo "   BASE=$BASE  HEAD=$HEAD_SHA"

# `git diff --quiet` returns 0 when there are no changes matching the
# pathspec, 1 when there are. Skip the build only when no relevant path changed.
if git diff --quiet "$BASE" "$HEAD_SHA" -- "${RELEVANT[@]}"; then
  echo "✅ No changes relevant to '$SCOPE' — skipping deploy."
  exit 0
fi

echo "🚀 Relevant changes detected — proceeding with deploy."
echo "   (Turbo Remote Cache will skip individual tasks if their inputs are unchanged.)"
exit 1
