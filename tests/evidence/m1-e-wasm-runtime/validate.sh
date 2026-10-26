#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Run only inside an admitted fleet job, on committed E1 source.
set -uo pipefail
result=0
run() {
  printf '\nM1-E CHECK %s\n' "$*"
  "$@"
  status=$?
  printf 'M1-E RESULT %s %s\n' "$status" "$*"
  if [ "$status" -ne 0 ]; then result=1; fi
}
# Fleet clones transfer committed objects, not local branch names.
expected_base=fb81254cb735f2f426981223f3fd92316ad784ea
if ! git rev-parse --verify m1/c-executor-core >/dev/null 2>&1; then
  git branch m1/c-executor-core "$expected_base" || exit 1
fi
if [ "$(git rev-parse m1/c-executor-core)" != "$expected_base" ]; then
  printf 'Refusing mismatched C base\n'; exit 1
fi
git rev-parse HEAD m1/c-executor-core
rustc --version
node --version
run pnpm install --frozen-lockfile --prefer-offline
# Confirm the production-only wasm warning on both unmodified ancestors.
# The fixture stays under the same pinned toolchain as the checkout.
comparison_root=$(mktemp -d)
comparison_source="$comparison_root/source"
trap 'rm -rf "$comparison_root"' EXIT
archive_at_comparison_path() {
  rm -rf "$comparison_source"
  mkdir -p "$comparison_source"
  git archive "$1" | tar -x -C "$comparison_source" || return 1
  find "$comparison_source/rust" -name '*.rs' -exec touch {} +
}
inherited_wasm_lint() {
  local revision=$1
  archive_at_comparison_path "$revision" || return 1
  printf 'M1-E ancestor %s\n' "$(git rev-parse "$revision")"
  (cd "$comparison_source" && rustc --version && cargo clippy --target wasm32-unknown-unknown -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-wasm -- -D warnings) > "$comparison_root/lint.log" 2>&1
  local status=$?
  cat "$comparison_root/lint.log"
  if [ "$status" -eq 101 ] && grep -q 'function `closed_or_hairline` is never used' "$comparison_root/lint.log"; then
    printf 'CONFIRMED inherited closed_or_hairline warning on %s\n' "$revision"
  else
    printf 'Unexpected ancestor lint outcome: %s\n' "$status"
    return 1
  fi
}
run inherited_wasm_lint eaf210fe63
run inherited_wasm_lint m1/c-executor-core
run cargo clippy --workspace --all-targets -- -D warnings
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-wasm -- -D warnings
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-wasm --features ifc-lite-wasm/retained-browser -- -D warnings
run cargo clippy -p ifc-lite-wasm --all-targets --features retained-browser -- -D warnings
# Also cover the test-support feature union used by geometry CI.
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-wasm --features ifc-lite-wasm/retained-browser,ifc-lite-geometry/test-support -- -D warnings
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-wasm --all-targets --features retained-browser -- -D warnings
run cargo test -p ifc-lite-geometry --features retained-runtime --lib
run cargo test -p ifc-lite-geometry --features retained-runtime --test m1_wasm_wire
run cargo test -p ifc-lite-processing --features retained-runtime --lib element::session_retained
run cargo test -p ifc-lite-wasm --lib --features retained-browser retained_browser
run cargo test -p ifc-lite-wasm --lib --features retained-browser --target wasm32-unknown-unknown --no-run
run cargo test -p ifc-lite-processing --test module_size_ratchet --test function_length_ratchet
run node --test scripts/retained-browser-driver.test.mjs
run node scripts/check-test-revert-oracle.mjs --base m1/c-executor-core --ci --json --mutation tests/evidence/m1-e-wasm-runtime/behaviour.oracle.patch --test rust/geometry/tests/m1_wasm_wire.rs
for guard in check-refwalk-guards check-float-sort-comparators check-module-size check-source-text-assertions check-test-wiring; do
  run node "scripts/$guard.mjs"
done
run node scripts/add-license-headers.mjs --check
# Recompile both snapshots at exactly the same source path. Rust embeds some
# absolute panic-location paths, so different archive/checkout roots create a
# false binary-size delta even when every function has the same size.
# Touch each snapshot to defeat stale shared-target reuse; never clean caches.
run archive_at_comparison_path m1/c-executor-core
run env CI=1 bash "$comparison_source/scripts/build-wasm.sh"
run cp "$comparison_source/packages/wasm/pkg/ifc-lite_bg.wasm" "$comparison_root/base.wasm"
run archive_at_comparison_path HEAD
run env CI=1 bash "$comparison_source/scripts/build-wasm.sh"
run node --input-type=module - "$comparison_root/base.wasm" "$comparison_source/packages/wasm/pkg/ifc-lite_bg.wasm" <<'JS'
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {brotliSize} from './scripts/perf-ratchet/measure-bundle.mjs';
const before = readFileSync(process.argv[2]);
const after = readFileSync(process.argv[3]);
const measure = bytes => ({raw:bytes.length, brotli:brotliSize(bytes), sha256:createHash('sha256').update(bytes).digest('hex')});
const baseline = measure(before), branch = measure(after);
const ratchet = JSON.parse(readFileSync('tests/perf-ratchets/bundle.json')).entries.find(e=>e.id==='engine-wasm-brotli');
console.log(JSON.stringify({baseline, branch, ceiling:ratchet.ceiling, identical:before.equals(after)}));
if (!before.equals(after) || branch.brotli > ratchet.ceiling * (1 + ratchet.tolerance.value)) process.exitCode=1;
JS
# The scaffold compiles above. Running real parity requires the staged SDK and
# D's native reference plus a browser; absence is not a green parity verdict.
if [ ! -f rust/wasm-bindings/smlib/ifclite_smlib_browser.wasm ]; then
  printf 'SKIP M1 native/wasm parity: real SMLib wasm engine is absent; scaffold compiled only\n'
else
  run wasm-pack test --headless --chrome rust/wasm-bindings --lib --features retained-browser -- retained_browser_m1_native_wasm_receipt_parity_scaffold
fi
exit "$result"
