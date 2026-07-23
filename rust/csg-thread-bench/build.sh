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
# Full shared-memory flag set (mirrors scripts/build-wasm.sh's validated threaded
# path). Without --shared-memory/--import-memory + the __wasm_init_tls exports the
# WebAssembly.Memory is NOT SharedArrayBuffer-backed, so wasm-bindgen-rayon's
# postMessage of the Memory to workers throws DataCloneError and initThreadPool
# fails. (Was missing here — the bench threaded build never actually booted.)
RUSTFLAGS='-C link-arg=--max-memory=4294967296 -C link-arg=-zstack-size=8388608 -C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base -C link-arg=--export=__heap_base' \
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
