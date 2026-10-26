#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# One committed PC fleet admission: independent checks, then actual SDK evidence.
set -uo pipefail
failure=0
run() {
  printf '\nCOMMAND:'; printf ' %q' "$@"; printf '\n'
  "$@"
  code=$?
  printf 'COMMAND_EXIT=%s\n' "$code"
  if [[ $code != 0 ]]; then failure=1; fi
  return "$code"
}
run cargo clippy --workspace --all-targets -- -D warnings
run cargo clippy --workspace --all-targets --features retained-runtime -- -D warnings
run cargo test -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-retained-native
run cargo test -p ifc-lite-geometry -p ifc-lite-processing -p ifc-lite-retained-native --features retained-runtime
run node scripts/check-test-revert-oracle.mjs --base m1/c-executor-core --mutation tests/evidence/m1-d-native-driver/behaviour.oracle.patch --ci
run node scripts/check-module-size.mjs
run node scripts/check-refwalk-guards.mjs
run node scripts/check-ci-path-coverage.mjs
run node scripts/check-test-wiring.mjs
run cargo package -p ifc-lite-processing --no-verify --list
if [[ $failure != 0 ]]; then exit "$failure"; fi
# SDK/source/build live in the owning admitted checkout, not a permanent cache.
export IFCLITE_SDK_CACHE="$PWD/.m1-native/sdk"
export IFCLITE_ADAPTER_BUILD="$PWD/.m1-native/build"
run bash native/smlib-adapter/qualify.sh || exit "$failure"
export IFCLITE_SMLIB_WORKER="$IFCLITE_ADAPTER_BUILD/ifclite_smlib_worker"
run cargo test -p ifc-lite-retained-native --features retained-runtime -- --nocapture
run cargo run -p ifc-lite-retained-native --features retained-runtime --example retained_compare -- \
  --worker "$IFCLITE_SMLIB_WORKER" --out "$PWD/.m1-native/committed" --committed
if [[ -f .m1-native/committed/summary.json ]]; then cat .m1-native/committed/summary.json; fi
exit "$failure"
