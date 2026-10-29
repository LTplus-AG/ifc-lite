#!/usr/bin/env bash
# Run ONLY through ifc-fleet. No nested admission, retries or guard overrides.
set -euo pipefail
phase=${1:?native or wasm}
if [[ "$phase" == native ]]; then
  cargo clippy --workspace --all-targets -- -D warnings
  cargo test --workspace
  for spec in 'c4-11b c4_11b_concurrent_batches' 'c4-11b-prepass c4_11b_metadata'; do
    read -r lane filter <<< "$spec"
    patch="tests/evidence/$lane/behaviour.oracle.patch"
    git apply --reverse --check "$patch"
    git apply --reverse "$patch"
    trap 'git apply "$patch"' EXIT
    set +e
    cargo test -p ifc-lite-wasm --lib "$filter" -- --nocapture > .c4-oracle.log 2>&1
    status=$?
    set -e
    cat .c4-oracle.log
    git apply "$patch"
    trap - EXIT
    rm .c4-oracle.log
    [[ $status == 101 ]] || { echo "oracle did not fail with Rust test failure: $status"; exit 1; }
    echo "C4_ORACLE_CAUGHT $lane"
  done
elif [[ "$phase" == wasm ]]; then
  # Temporary source export lives in this managed task checkout, shares only
  # the admitted Cargo target, and is removed after the matched pair check.
  base=06cf74244610e5272ffbff53b54db88e1eac0675
  scratch="$PWD/.c4-baseline"
  [[ ! -e "$scratch" ]] || { echo 'baseline scratch already exists'; exit 1; }
  mkdir "$scratch"
  trap 'rm -rf -- "$scratch"' EXIT
  git archive "$base" | tar -x -C "$scratch"
  (cd "$scratch"; CI=1 bash scripts/build-wasm.sh)
  pnpm install --frozen-lockfile --prefer-offline
  # Fresh build is mandatory: CI=1 forbids build-wasm's developer soft skip.
  CI=1 pnpm build:wasm
  git diff --exit-code -- 'packages/wasm/pkg*/ifc-lite.d.ts'
  IFC_WASM_BASE_JS="$scratch/packages/wasm/pkg/ifc-lite.js" \
  IFC_WASM_BASE_BINARY="$scratch/packages/wasm/pkg/ifc-lite_bg.wasm" \
    pnpm test:wasm-contract
  rm -rf -- "$scratch"
  trap - EXIT
else
  echo "unknown phase: $phase" >&2; exit 2
fi
