#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Measure the WASM bundle delta between the legacy BSP CSG kernel and
# the Manifold CSG kernel (T1.1).
#
# The legacy build is exercised on every PR via test.yml; that build
# always succeeds. The Manifold build is currently blocked on an
# upstream `manifold-csg-sys` wasm-cxx-shim incompatibility with
# libc++-{18, 20} — see docs/architecture/geometry-pipeline.md "WASM
# status". This script attempts both, captures the failure in a
# structured way for the Manifold path, and prints a side-by-side
# size table.
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

# Build the legacy (BSP CSG) variant via the existing pipeline. This is
# the production path today.
echo "Building default WASM bundle (legacy BSP CSG kernel)..." >&2
bash scripts/build-wasm.sh > /tmp/build-wasm-bsp.log 2>&1
bsp_exit=$?
bsp_path="packages/wasm/pkg/ifc-lite_bg.wasm"
bsp_size=0
if [ $bsp_exit -eq 0 ] && [ -f "$bsp_path" ]; then
    bsp_size=$(wc -c < "$bsp_path")
fi

# Attempt the Manifold variant. We invoke cargo directly rather than
# wasm-pack because the failure surface we want to capture is the
# build script for `manifold-csg-sys`, not wasm-bindgen post-processing.
echo "Attempting WASM build with --features manifold-csg-wasm-uu..." >&2
manifold_exit=0
manifold_log=$(mktemp)
cargo build --manifest-path rust/wasm-bindings/Cargo.toml \
    --features ifc-lite-geometry/manifold-csg-wasm-uu \
    --target wasm32-unknown-unknown \
    --release > "$manifold_log" 2>&1 || manifold_exit=$?

manifold_size=0
manifold_blocker=""
if [ $manifold_exit -eq 0 ]; then
    # Locate the produced .wasm; the artifact name follows the package name.
    candidate=$(find target/wasm32-unknown-unknown/release -maxdepth 1 -name '*.wasm' -print -quit 2>/dev/null || true)
    if [ -n "${candidate:-}" ]; then
        manifold_size=$(wc -c < "$candidate")
    fi
else
    # Extract the most informative line from the build log.
    manifold_blocker=$(grep -m1 -E "fatal error:|error: " "$manifold_log" | head -1 || true)
    if [ -z "$manifold_blocker" ]; then
        manifold_blocker="cargo build exited $manifold_exit"
    fi
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
  "bsp": { "ok": $([ $bsp_exit -eq 0 ] && echo true || echo false), "bytes": $bsp_size },
  "manifold": { "ok": $([ $manifold_exit -eq 0 ] && echo true || echo false), "bytes": $manifold_size, "blocker": "${manifold_blocker//\"/\\\"}" },
  "delta_bytes": $((manifold_size - bsp_size))
}
EOF
else
    echo
    echo "WASM bundle size — ifc-lite-wasm @ wasm32-unknown-unknown"
    echo "─────────────────────────────────────────────────────────"
    printf "  %-32s %s\n" "Legacy (BSP CSG, default)" "$(fmt_kib $bsp_size)"
    if [ $manifold_exit -eq 0 ]; then
        delta=$((manifold_size - bsp_size))
        sign="+"
        if [ "$delta" -lt 0 ]; then sign=""; fi
        printf "  %-32s %s  (%s%s)\n" \
            "Manifold (--features manifold-csg-wasm-uu)" \
            "$(fmt_kib $manifold_size)" \
            "$sign" "$(fmt_kib ${delta#-})"
    else
        printf "  %-32s %s\n" "Manifold (--features manifold-csg-wasm-uu)" "BLOCKED"
        echo "    └─ $manifold_blocker"
        echo "    └─ Tracker: docs/architecture/geometry-pipeline.md \"WASM status\""
    fi
fi

# Always exit 0 — the Manifold-blocked case is informational, not a failure.
exit 0
