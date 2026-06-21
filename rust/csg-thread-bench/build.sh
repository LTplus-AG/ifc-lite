#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build the rung-2 CSG bench into web/pkg-plain and web/pkg-threaded, then
# serve with `node web/serve.mjs` and open
#   http://localhost:8099/?pkg=threaded&mode=csg&model=<fixture>&parallel=1&threads=8
#
# The threaded bundle pulls wasm-bindgen-rayon, whose generated worker helper
# does a *directory* dynamic import (`import('../../..')`). A bare static file
# server (web/serve.mjs) cannot resolve a directory specifier, so the worker
# silently fails to boot and the threaded run hangs before `initThreadPool`
# resolves. The production pipeline avoids this in scripts/build-wasm.sh by
# rewriting the helper after wasm-pack; we apply the SAME rewrite here so the
# bench is runnable straight after a build with no manual patching. (#1255 P2)
set -euo pipefail
cd "$(dirname "$0")"

OUT_PLAIN=web/pkg-plain
OUT_THREADED=web/pkg-threaded

echo "==> building plain bundle -> $OUT_PLAIN"
wasm-pack build --release --target web --out-dir "$OUT_PLAIN" --out-name csgbench

echo "==> building threaded bundle -> $OUT_THREADED"
RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals' \
  rustup run nightly \
  wasm-pack build --release --target web --out-dir "$OUT_THREADED" \
  --out-name csgbench -- --features threads -Z build-std=std,panic_abort

# Rewrite the wasm-bindgen-rayon worker helper's directory import to a concrete,
# server-resolvable module path so the worker boots under web/serve.mjs.
helper=$(find "$OUT_THREADED/snippets" -name '*.js' -path '*wasm-bindgen-rayon*' 2>/dev/null | head -1 || true)
if [[ -n "${helper:-}" ]]; then
  # `import('../../..')` / `import('../../../')` -> `import('../../../csgbench.js')`
  perl -0pi -e "s{import\(\s*['\"](\.\./\.\./\.\.)/?['\"]\s*\)}{import('\$1/csgbench.js')}g" "$helper"
  echo "==> patched worker helper: $helper"
else
  echo "WARN: wasm-bindgen-rayon worker helper not found; threaded bench may hang" >&2
fi

echo "==> done. serve: node web/serve.mjs"
