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

echo "Building WASM bundle (pure-Rust CSG kernel)..." >&2
bash scripts/build-wasm.sh > /tmp/build-wasm.log 2>&1
build_exit=$?
wasm_path="packages/wasm/pkg/ifc-lite_bg.wasm"
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

if [ "$JSON" -eq 1 ]; then
    cat <<EOF
{
  "bundle": { "ok": $([ $build_exit -eq 0 ] && echo true || echo false), "bytes": $wasm_size }
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

exit 0
