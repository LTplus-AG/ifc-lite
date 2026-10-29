#!/usr/bin/env bash
# Reproduce the oracle with a fresh diff WASM bundle on each arm.
set -euo pipefail
patch=tests/evidence/sparse-fingerprints-8114/behaviour.oracle.patch
out=${1:?pass an evidence output directory outside the checkout}
mkdir -p "$out"
pnpm install --frozen-lockfile > "$out/install.log" 2>&1
pnpm build --filter=@ifc-lite/diff > "$out/build-ts.log" 2>&1
build_diff() {
  CARGO_UNSTABLE_BUILD_STD=std,panic_abort rustup run nightly-2025-11-15 wasm-pack build rust/diff-wasm \
    --target web --out-dir ../../packages/wasm/pkg-diff --out-name ifc-lite-diff --release
  # Match build-wasm.sh: omit platform-dependent generated trampoline indices.
  local dts=packages/wasm/pkg-diff/ifc-lite-diff.d.ts
  grep -v __wasm_bindgen_func_elem_ "$dts" > "$dts.tmp"
  mv "$dts.tmp" "$dts"
}
arm() {
  local name=$1
  build_diff > "$out/$name-build.log" 2>&1
  set +e
  cargo test -p ifc-lite-diff > "$out/$name-rust.log" 2>&1
  local rust=$?
  node --experimental-strip-types --test packages/wasm/test/diff-parity.test.mjs > "$out/$name-node.log" 2>&1
  local node=$?
  set -e
  printf '%s rust=%s node=%s\n' "$name" "$rust" "$node" | tee -a "$out/results.txt"
  if [[ $name == mutated ]]; then
    [[ $rust != 0 && $node != 0 ]]
    grep -q 'test result: FAILED' "$out/$name-rust.log"
    grep -q 'ERR_ASSERTION' "$out/$name-node.log"
  else
    [[ $rust == 0 && $node == 0 ]]
  fi
}
arm baseline
git apply --reverse "$patch"
trap 'git apply "$patch"' EXIT
arm mutated
git apply "$patch"
trap - EXIT
arm restored
