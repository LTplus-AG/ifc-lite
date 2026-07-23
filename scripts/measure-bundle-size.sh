#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Measure the WASM bundle size.
#
# Since M9 of the CSG kernel consolidation there is exactly ONE kernel —
# the pure-Rust exact mesh-arrangement kernel — so this script builds the
# production bundle and reports its size (the historical BSP-vs-Manifold
# comparison is gone along with both kernels).
#
# Output is plain text suitable for a PR comment or CI log; pass
# --json for machine-readable output.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

JSON=0
if [ "${1:-}" = "--json" ]; then
    JSON=1
fi

wasm_path="packages/wasm/pkg/ifc-lite_bg.wasm"
# Remove any stale artifact FIRST so the `ok`/size below can only reflect a
# binary produced by THIS build. Otherwise a soft-skip (no wasm-pack) would
# leave a previous build's .wasm in place and report ok:true on stale bytes —
# the exact stale-artifact trap this repo's perf work keeps hitting.
rm -f "$wasm_path"

echo "Building WASM bundle (pure-Rust CSG kernel)..." >&2
bash scripts/build-wasm.sh > /tmp/build-wasm.log 2>&1
build_exit=$?
wasm_size=0
if [ $build_exit -eq 0 ] && [ -f "$wasm_path" ]; then
    wasm_size=$(wc -c < "$wasm_path")
fi

# Pretty-print KiB at one decimal.
fmt_kib() {
    if [ "$1" -eq 0 ]; then
        echo "—"
    else
        awk -v b="$1" 'BEGIN { printf "%.1f KiB", b/1024 }'
    fi
}

# `ok` must reflect a real, present artifact — not just a zero build exit. When
# build-wasm.sh soft-skips (no wasm-pack), build_exit is 0 but $wasm_path is
# absent, so an ok-on-build_exit-alone would report `ok:true, bytes:0` while the
# script exits 1 — a successful zero-byte measurement to a machine consumer.
ok=false
if [ $build_exit -eq 0 ] && [ -f "$wasm_path" ]; then
    ok=true
fi

if [ "$JSON" -eq 1 ]; then
    cat <<EOF
{
  "bundle": { "ok": $ok, "bytes": $wasm_size }
}
EOF
else
    echo
    echo "WASM bundle size — ifc-lite-wasm @ wasm32-unknown-unknown"
    echo "─────────────────────────────────────────────────────────"
    printf "  %-32s %s\n" "Bundle (pure-Rust CSG kernel)" "$(fmt_kib $wasm_size)"
    if [ $build_exit -ne 0 ]; then
        echo "    └─ build FAILED — see /tmp/build-wasm.log"
    fi
fi

# Propagate build failure (and a missing artifact) as a non-zero exit so a CI
# size gate can't read this as "0 KiB, all good". A green build with the wasm
# present exits 0.
if [ $build_exit -ne 0 ] || [ ! -f "$wasm_path" ]; then
    exit 1
fi
exit 0
