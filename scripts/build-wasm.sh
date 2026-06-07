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

# Find wasm-pack - check PATH first, then cargo bin directory.
#
# Soft-skip path (#654, #952). The wasm *runtime* (ifc-lite_bg.wasm /
# ifc-lite.js) is NOT committed — it's gitignored and rebuilt from rust/** on
# every Rust-capable host. The *type surface* (pkg/ifc-lite.d.ts) IS committed
# so type-checking never needs Rust. Environments without a Rust toolchain —
# e.g. a contributor who doesn't touch Rust, or a typecheck-only lane — should
# rebuild from source when possible but soft-skip when not, so a missing
# wasm-pack doesn't hard-fail `turbo build` / `turbo typecheck`. (CI's build
# job and Vercel do install Rust and rebuild from source.)
WASM_PACK="wasm-pack"
if ! command -v wasm-pack &> /dev/null; then
  CARGO_BIN="$HOME/.cargo/bin/wasm-pack"
  # `-x` (executable) not `-f` (exists): a non-exec leftover at this path
  # would otherwise pass the guard and then fail on invocation
  # (CodeRabbit #657).
  if [ -x "$CARGO_BIN" ]; then
    WASM_PACK="$CARGO_BIN"
    echo "   Using wasm-pack from cargo bin: $WASM_PACK"
  else
    # No wasm-pack. Don't hard-fail the turbo `^build` graph that `typecheck`
    # depends on: succeed when a previously built runtime OR the committed type
    # surface is already on disk. Type-checking works either way; running or
    # bundling the app still needs the real runtime (the viewer's vite build
    # demands the .js/.wasm), so this can't silently mask a missing runtime.
    EXPECTED_DTS="packages/wasm/pkg/ifc-lite.d.ts"
    EXPECTED_WASM="packages/wasm/pkg/ifc-lite_bg.wasm"
    if [ -f "$EXPECTED_WASM" ]; then
      echo "⚠️  wasm-pack not found — using the wasm runtime already on disk at $EXPECTED_WASM"
      echo "   (To rebuild from Rust sources, install Rust + wasm-pack:"
      echo "    https://rustwasm.github.io/wasm-pack/installer/)"
      exit 0
    fi
    if [ -f "$EXPECTED_DTS" ]; then
      echo "⚠️  wasm-pack not found — committed types at $EXPECTED_DTS are present,"
      echo "   so type-checking works, but the wasm runtime is NOT built. The app"
      echo "   won't run or bundle until you install Rust + wasm-pack and rebuild:"
      echo "     https://rustwasm.github.io/wasm-pack/installer/"
      exit 0
    fi
    echo "❌ Error: wasm-pack not found in PATH or ~/.cargo/bin/ and no pre-built artifact at $EXPECTED_WASM"
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

OUT_DIR="../../packages/wasm/pkg"
echo "🟢 Building single-thread bundle → $OUT_DIR"

rustup run nightly-2025-11-15 "$WASM_PACK" build rust/wasm-bindings \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name ifc-lite \
  --release \
  $FEATURES

# NOTE: wasm-opt is disabled. The bundle is single-threaded (SIMD128 only,
# no atomics/shared-memory), and the Rust compiler's LLVM -O3 (release
# profile) already provides sufficient optimization. wasm-opt also has a
# history of miscompiling the wasm-bindgen closure/async machinery
# (RuntimeError: unreachable in production), so it stays off.
echo "ℹ️  wasm-opt disabled — using LLVM -O3 only"

# Strip wasm-bindgen's internal trampoline indices from the committed type
# surface (#952). The `__wasm_bindgen_func_elem_<N>` members of `InitOutput`
# are internal closure indices that wasm-bindgen renumbers per platform for the
# same source (e.g. 709 on linux CI vs 714 on macOS) — nothing outside
# packages/wasm/pkg/ ever references them. Removing them makes pkg/ifc-lite.d.ts
# platform-independent so the CI "types in sync" gate can do an exact diff. The
# runtime .js still carries them; only the .d.ts type omits them.
DTS_PATH="$(echo "$OUT_DIR" | sed 's|^../../||')/ifc-lite.d.ts"
if [ -f "$DTS_PATH" ]; then
  grep -v '__wasm_bindgen_func_elem_' "$DTS_PATH" > "$DTS_PATH.tmp" && mv "$DTS_PATH.tmp" "$DTS_PATH"
  echo "🧹 stripped internal __wasm_bindgen_func_elem_* indices from $DTS_PATH"
fi

# Show bundle size
echo ""
echo "📊 Bundle size:"
# OUT_DIR is relative to rust/wasm-bindings/ from wasm-pack's perspective;
# resolve from repo root for the size check.
SIZE_PATH="$(echo "$OUT_DIR" | sed 's|^../../||')/ifc-lite_bg.wasm"
ls -lh "$SIZE_PATH" | awk '{print "   WASM: " $5}'

WASM_SIZE=$(wc -c < "$SIZE_PATH")
# Single-thread bundle budget: 1100 KB. This slim bundle is what every
# consumer loads; keep it tight.
TARGET_SIZE=$((1100 * 1024))
TARGET_LABEL="1100 KB (single-thread)"

if [ $WASM_SIZE -lt $TARGET_SIZE ]; then
  echo "   ✅ Under $TARGET_LABEL target!"
else
  echo "   ⚠️  Over $TARGET_LABEL target ($(($WASM_SIZE / 1024))KB)"
fi

echo ""
echo "✨ Build complete!"
