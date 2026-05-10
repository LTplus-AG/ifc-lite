#!/bin/bash
set -e

# Get script directory and root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

# Source cargo environment if available (adds cargo to PATH)
if [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

echo "🦀 Building IFC-Lite WASM..."

# Build with wasm-pack
echo "📦 Running wasm-pack..."

# Find wasm-pack - check PATH first, then cargo bin directory
WASM_PACK="wasm-pack"
if ! command -v wasm-pack &> /dev/null; then
  # Try cargo's bin directory (common location for cargo-installed binaries)
  CARGO_BIN="$HOME/.cargo/bin/wasm-pack"
  if [ -f "$CARGO_BIN" ]; then
    WASM_PACK="$CARGO_BIN"
    echo "   Using wasm-pack from cargo bin: $WASM_PACK"
  else
    echo "❌ Error: wasm-pack not found in PATH or ~/.cargo/bin/"
    echo "   Install with: cargo install wasm-pack"
    exit 1
  fi
fi

# Check if debug_geometry feature should be enabled
FEATURES=""
if [ "${DEBUG_GEOMETRY:-}" = "1" ]; then
  FEATURES="--features debug_geometry"
  echo "🔍 Building with debug_geometry feature enabled"
fi

# THREADED build path (Phase 1.4 of single-controller-rayon-design.md).
# When THREADED=1, build a SECOND artifact at packages/wasm-threaded/pkg/
# with shared memory + rayon enabled. The default (THREADED unset)
# produces the existing slim single-thread bundle at packages/wasm/pkg/.
#
# Key facts validated by the spike at spike/path-b-respike (8fcaff96):
#  - The full RUSTFLAGS set below is what was missing in March 2026.
#    `--export=__wasm_init_tls` (and the `__tls_size`/`__tls_align`/
#    `__tls_base` companions) are required or wasm-bindgen CLI fails
#    with "failed to find __wasm_init_tls".
#  - +atomics is unstable; rustc warns but produces working code on
#    nightly-2025-11-15.
#  - `wasm-opt --enable-threads` miscompiles wasm-bindgen closure
#    machinery — keep wasm-opt disabled.
THREADED="${THREADED:-0}"
if [ "$THREADED" = "1" ]; then
  OUT_DIR="../../packages/wasm-threaded/pkg"
  EXTRA_FEATURES="--features threading"
  # Set RUSTFLAGS as full replacement (env var overrides
  # .cargo/config.toml's [target.wasm32].rustflags). Includes the
  # default flags PLUS the threading-specific ones.
  export RUSTFLAGS="-C link-arg=--max-memory=4294967296 -C link-arg=-zstack-size=8388608 -C target-feature=+simd128,+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base"
  echo "🧵 Building THREADED bundle → $OUT_DIR"
else
  OUT_DIR="../../packages/wasm/pkg"
  EXTRA_FEATURES=""
  echo "🟢 Building single-thread bundle → $OUT_DIR"
fi

rustup run nightly-2025-11-15 "$WASM_PACK" build rust/wasm-bindings \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name ifc-lite \
  --release \
  $FEATURES $EXTRA_FEATURES

# NOTE: wasm-opt is disabled.
# Multiple wasm-opt versions (npm and cargo) have been tested and all miscompile
# the wasm-bindgen closure/async machinery when --enable-threads is used,
# causing RuntimeError: unreachable in production. The Rust compiler's LLVM -O3
# (release profile) provides sufficient optimization.
echo "ℹ️  wasm-opt disabled — using LLVM -O3 only"

# Show bundle size
echo ""
echo "📊 Bundle size:"
# OUT_DIR is relative to rust/wasm-bindings/ from wasm-pack's perspective;
# resolve from repo root for the size check.
SIZE_PATH="$(echo "$OUT_DIR" | sed 's|^../../||')/ifc-lite_bg.wasm"
ls -lh "$SIZE_PATH" | awk '{print "   WASM: " $5}'

WASM_SIZE=$(wc -c < "$SIZE_PATH")
# Threaded bundle is ~10% larger due to atomics + thread-pool init code
TARGET_SIZE=$((1300 * 1024))

if [ $WASM_SIZE -lt $TARGET_SIZE ]; then
  echo "   ✅ Under target!"
else
  echo "   ⚠️  Over target ($(($WASM_SIZE / 1024))KB)"
fi

echo ""
echo "✨ Build complete!"
