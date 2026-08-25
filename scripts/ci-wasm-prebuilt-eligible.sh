#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# CI prebuilt-WASM eligibility probe (see scripts/README-vercel-cost.md §1a).
#
# Emits a single token on STDOUT — `true` or `false` — for the test.yml
# `changes` job to expose as an output. All diagnostics go to STDERR so the
# captured value is a clean boolean.
#
#   true  → the published @ifc-lite/wasm bundle is byte-for-byte reproducible
#           from this checkout (the WASM source is identical to the release tag
#           that built it), so `build` can fetch the prebuilt bundle and run on
#           a FREE runner instead of compiling wasm32 on a paid Depot runner.
#   false → ANY uncertainty (version unreadable, tag unreachable, Rust source
#           differs). `build` then compiles from source on Depot, exactly as
#           before. The fast path can NEVER cause a stale bundle to be tested.
#
# This is the CI twin of the fast path in scripts/vercel-install.sh — keep the
# WASM_SRC_PATHS list and the "any doubt → build from source" guarantee in
# lock-step with that script.
set -uo pipefail

log() { echo "$@" >&2; }

WASM_VERSION="$(node -p "require('./packages/wasm/package.json').version" 2>/dev/null || true)"
if [ -z "${WASM_VERSION:-}" ]; then
  log "🛠  wasm version unreadable — build from source."
  echo false
  exit 0
fi

WASM_TAG="@ifc-lite/wasm@${WASM_VERSION}"
# Conservative superset: any Rust workspace change invalidates the fast path,
# even one that can't reach the wasm-bindings crate. Correctness over savings.
# MUST match WASM_SRC_PATHS in scripts/vercel-install.sh.
WASM_SRC_PATHS=(rust Cargo.lock Cargo.toml rust-toolchain.toml scripts/build-wasm.sh)

_tag_present() { git rev-parse -q --verify "refs/tags/${WASM_TAG}^{commit}" >/dev/null 2>&1; }

if ! _tag_present; then
  # actions/checkout is a shallow clone without tags — fetch just this one
  # release tag from origin (anonymous read; ifc-lite is public) so we can diff
  # against it. Best-effort: a blocked fetch simply leaves the tag absent and we
  # fall through to the from-source build below.
  log "ℹ️  Fetching release tag ${WASM_TAG} from origin (shallow)…"
  git fetch --depth=1 origin "+refs/tags/${WASM_TAG}:refs/tags/${WASM_TAG}" >&2 2>&1 || true
fi

if ! _tag_present; then
  log "🛠  Release tag ${WASM_TAG} not reachable in this clone — build from source."
  echo false
  exit 0
fi

# Every pathspec must actually MATCH something at the tag before its "no diff"
# answer can be trusted (#3200, finding 10). `git diff --quiet` exits 0 both for
# "nothing changed" and for "your pathspec matched nothing at either end":
#
#   $ git diff --quiet HEAD~1 HEAD -- probe             # EXIT=1  (real path)
#   $ git diff --quiet HEAD~1 HEAD -- rustXX Cargo.lock # EXIT=0  (typo'd path)
#
# so a typo'd entry silently covers nothing AND moves the answer toward `true`
# — against this file's stated guarantee that the fast path can NEVER cause a
# stale bundle to be tested. The list must be kept in lock-step with
# scripts/vercel-install.sh BY HAND, which is exactly where such a typo comes
# from. Checking at the TAG rather than at HEAD is deliberate: that is the side
# whose contents the prebuilt bundle was built from.
for _p in "${WASM_SRC_PATHS[@]}"; do
  if [ -z "$(git ls-tree -r --name-only "refs/tags/${WASM_TAG}" -- "${_p}" 2>/dev/null | head -1)" ]; then
    log "🛠  WASM_SRC_PATHS entry '${_p}' matches no file at ${WASM_TAG} — refusing to trust a"
    log "    no-diff answer over a pathspec that covers nothing. Build from source."
    echo false
    exit 0
  fi
done

if git diff --quiet "refs/tags/${WASM_TAG}" HEAD -- "${WASM_SRC_PATHS[@]}"; then
  log "🅰  WASM source identical to ${WASM_TAG} — prebuilt npm bundle is valid."
  echo true
  exit 0
fi

log "🛠  Rust sources changed since ${WASM_TAG} — build from source."
git diff --name-only "refs/tags/${WASM_TAG}" HEAD -- "${WASM_SRC_PATHS[@]}" \
  | sed 's/^/     changed: /' | head -20 >&2 || true
echo false
exit 0
