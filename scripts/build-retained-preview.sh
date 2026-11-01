#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build the retained-only hosted preview (#7955) from this checkout, end to end:
# retained Rust bundle, SMLib browser build from the pinned SDK, staged engine,
# retained-enabled viewer, assembled static preview. Never deploys.
#
#   bash scripts/build-retained-preview.sh --sdk /abs/usd-brep --emsdk /abs/emsdk \
#     --work /abs/new-dir (--source-tag v27.1.1 | --rehearsal)
#
# --source-tag requires HEAD to be that tag's commit and fills the covered-source
# URL in licenses/retained/THIRD_PARTY_NOTICES.txt for the build only (restored on
# exit), so every staged notice copy names the exact release source.
# Output: <work>/preview (vercel.json + public/), <work>/engine, <work>/smlib-build.
set -euo pipefail

usage() { echo "Usage: bash scripts/build-retained-preview.sh --sdk ABS --emsdk ABS --work ABS (--source-tag vX.Y.Z | --rehearsal)" >&2; exit 1; }
sdk="" emsdk="" work="" tag="" rehearsal=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sdk) sdk="${2:-}"; shift 2 ;;
    --emsdk) emsdk="${2:-}"; shift 2 ;;
    --work) work="${2:-}"; shift 2 ;;
    --source-tag) tag="${2:-}"; shift 2 ;;
    --rehearsal) rehearsal=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$sdk" ] && [ -n "$emsdk" ] && [ -n "$work" ] || usage
case "$sdk$emsdk$work" in *' '*) usage ;; esac
for p in "$sdk" "$emsdk" "$work"; do case "$p" in /*) ;; *) usage ;; esac; done
if [ -n "$tag" ] && [ -n "$rehearsal" ] || [ -z "$tag$rehearsal" ]; then usage; fi
if [ -n "${VERCEL:-}" ]; then echo "Refusing to build a retained preview inside a Vercel build" >&2; exit 1; fi
[ ! -e "$work" ] || { echo "Work directory already exists: $work" >&2; exit 1; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
notice=licenses/retained/THIRD_PARTY_NOTICES.txt
# The template drift check runs on the committed placeholder, before any fill.
node scripts/retained-notices.mjs --check
if [ -n "$tag" ]; then
  [ "$(git rev-parse HEAD)" = "$(git rev-parse "$tag^{commit}")" ] || { echo "HEAD is not $tag" >&2; exit 1; }
  git diff --quiet HEAD -- || { echo "Checkout has uncommitted changes" >&2; exit 1; }
  trap 'git checkout -- "$notice"' EXIT
  node --input-type=module -e "
    import { readFileSync, writeFileSync } from 'node:fs';
    import { fillSourceTag } from './scripts/lib/retained-preview.mjs';
    writeFileSync('$notice', fillSourceTag(readFileSync('$notice', 'utf8'), '$tag'));"
fi
mkdir -p "$work"

pnpm install --frozen-lockfile
env BUILD_RETAINED=1 bash scripts/build-wasm.sh
# shellcheck disable=SC1091
source "$emsdk/emsdk_env.sh" >/dev/null
emcmake cmake -S native/smlib-adapter -B "$work/smlib-build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE="$sdk"
cmake --build "$work/smlib-build" --parallel 4
node scripts/stage-cli-retained-engine.mjs --build "$work/smlib-build" --sdk "$sdk" \
  --pkg-retained "$root/packages/wasm/pkg-retained" --out "$work/engine" \
  --toolchain-notice "Emscripten-LICENSE=$emsdk/upstream/emscripten/LICENSE"

env -u VERCEL VITE_RETAINED_GEOMETRY=on IFCLITE_RETAINED_ENGINE="$work/engine" pnpm build:e2e
if [ -n "$tag" ]; then mode=(--source-tag "$tag"); else mode=(--rehearsal); fi
node scripts/build-retained-preview.mjs --dist "$root/apps/viewer/dist" --engine "$work/engine" \
  --out "$work/preview" "${mode[@]}"
