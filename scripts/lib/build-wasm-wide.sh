#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# The optional wide-arithmetic bundle (`BUILD_WIDE=1 scripts/build-wasm.sh`).
# Kept as a sourceable function so build-wasm-wide.test.mjs can drive it with
# stub `rustup` / `wasm-pack` / `wasm-tools` instead of a real wasm build.
#
# Same single-thread bundle as `pkg`, plus the wasm wide-arithmetic proposal
# (+wide-arithmetic), which maps the exact-CSG kernel's bnum 64x64->128 limb
# products to i64.mul_wide / i64.add128 instead of __multi3 libcalls. Measured
# ~1.7x on a real void cut (docs/architecture/wasm-wide-arithmetic.md). Selected
# at runtime via a WebAssembly.validate() probe (packages/geometry/src/wasm-features.ts,
# NOT yet created — see docs/architecture/wasm-wide-arithmetic.md delivery plan);
# engines without the proposal load the `pkg` bundle and are unaffected.
#
# It builds on its own toolchain, newer than the repo pin (rust-toolchain.toml),
# because LLVM < 23 miscompiles wide-arithmetic: WebAssemblyRegStackify
# stackified the first result of the two-result i64.mul_wide_s, so
# `i64::checked_mul` compared a stale operand instead of the high word and
# reported overflow for 5 * 7. Fixed upstream by llvm/llvm-project#200429
# (LLVM 23 only; LLVM 22.1.8 is still affected). The default bundles never emit
# these ops, so they stay on the repo pin. Override with WIDE_TOOLCHAIN=... to
# try another nightly; the LLVM check still applies.
#
# Must be called from the repo root. Reads WASM_PACK (the wasm-pack binary) and
# FEATURES (extra cargo args) from the caller; exits non-zero on any refusal.

WIDE_TOOLCHAIN_DEFAULT="nightly-2026-10-15"
WIDE_MIN_LLVM_MAJOR=23

build_wide_bundle() {
  local toolchain="${WIDE_TOOLCHAIN:-$WIDE_TOOLCHAIN_DEFAULT}"
  local out="../../packages/wasm/pkg-wide"
  local rel="packages/wasm/pkg-wide"
  local llvm_major

  llvm_major="$(rustup run "$toolchain" rustc -vV 2>/dev/null | sed -n 's/^LLVM version: \([0-9]*\).*/\1/p')"
  if [ -z "$llvm_major" ]; then
    echo "🔢 ❌ cannot read the LLVM version of $toolchain — install it with:"
    echo "      rustup toolchain install $toolchain --profile minimal --target wasm32-unknown-unknown --component rust-src"
    return 1
  fi
  if [ "$llvm_major" -lt "$WIDE_MIN_LLVM_MAJOR" ]; then
    echo "🔢 ❌ $toolchain uses LLVM $llvm_major, which miscompiles i64 overflow checks under"
    echo "      +wide-arithmetic (llvm/llvm-project#200429, fixed in LLVM $WIDE_MIN_LLVM_MAJOR). Refusing to build a wrong bundle."
    return 1
  fi

  echo ""
  echo "🔢 Building wide-arithmetic bundle → $out (+wide-arithmetic, $toolchain / LLVM $llvm_major)"
  # RUSTFLAGS fully replaces .cargo/config.toml's target rustflags, so repeat the
  # base flags (max-memory, stack-size, simd128) and add +wide-arithmetic.
  # shellcheck disable=SC2086 # FEATURES is deliberately word-split
  RUSTFLAGS="-C link-arg=--max-memory=4294967296 -C link-arg=-zstack-size=8388608 -C target-feature=+simd128,+wide-arithmetic" \
  rustup run "$toolchain" "$WASM_PACK" build rust/wasm-bindings \
    --target web \
    --out-dir "$out" \
    --out-name ifc-lite \
    --release \
    -- $FEATURES || return 1

  local dts="$rel/ifc-lite.d.ts"
  if [ -f "$dts" ]; then
    grep -v '__wasm_bindgen_func_elem_' "$dts" > "$dts.tmp" && mv "$dts.tmp" "$dts"
  fi
  # Litmus test: the bundle must actually contain wide-arithmetic ops.
  # wasm-tools is REQUIRED — without it we cannot verify the bundle isn't
  # silently baseline wasm, so refuse rather than ship an unverified bundle.
  if ! command -v wasm-tools >/dev/null 2>&1; then
    echo "🔢 ❌ wasm-tools not found — required for BUILD_WIDE=1 to verify wide ops; refusing to ship an unverified bundle"
    echo "      Install it with: cargo install wasm-tools"
    return 1
  fi
  if [ "$(wasm-tools print "$rel/ifc-lite_bg.wasm" 2>/dev/null | grep -cE 'mul_wide|add128|sub128')" -gt 0 ]; then
    echo "🔢 ✅ wide-arithmetic bundle emits wide ops"
  else
    echo "🔢 ❌ wide-arithmetic bundle has NO wide ops — flags wrong; refusing to ship"
    return 1
  fi
  ls -lh "$rel/ifc-lite_bg.wasm" | awk '{print "   Wide WASM: " $5 " (no budget — not the default bundle)"}'
}
