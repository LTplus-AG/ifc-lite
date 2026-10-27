#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Run only through machine admission. No worker means native SDK tests SKIP;
# validate-native.sh separately requires the real SDK before counting them.
set -euo pipefail
cargo test -p ifc-lite-retained-native --features retained-runtime -- --nocapture
cargo test -p ifc-lite-retained-native --features retained-runtime --example retained_compare
cargo clippy -p ifc-lite-retained-native --features retained-runtime --all-targets -- -D warnings
patch=tests/evidence/m3-0-opening-oracle/behaviour.oracle.patch
log=$(mktemp)
restored=0
restore() {
  if [[ "$restored" == 0 ]]; then git apply "$patch"; fi
  rm -f "$log"
}
git apply --reverse --check "$patch"
git apply --reverse "$patch"
trap restore EXIT
status=0
cargo test -p ifc-lite-retained-native --features retained-runtime --test m3_opening_oracle issue_2019_hand_derived_bands -- --nocapture >"$log" 2>&1 || status=$?
cat "$log"
[[ "$status" == 101 ]]
grep -F 'test issue_2019_hand_derived_bands ... FAILED' "$log"
! grep -E 'error\[E[0-9]+\]|could not compile' "$log"
echo 'M3-0 mutation compiled and the hand-derived witness failed as required'
git apply "$patch"
restored=1
git diff --exit-code -- rust/retained-native/src/oracle/openings.rs
cargo test -p ifc-lite-retained-native --features retained-runtime --test m3_opening_oracle issue_2019_hand_derived_bands
