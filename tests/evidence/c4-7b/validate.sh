#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# C4-7b (#8341). Run ONLY through ifc-fleet; no nested admission or retries.
set -euo pipefail
case "${1:-native}" in
  native)
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test -p ifc-lite-wasm -p ifc-lite-processing -p ifc-lite-geometry
    git diff --exit-code -- rust/wasm-bindings/src/api/gpu_meshes/batch_parity_expected.json
    ;;
  mutation)
    patch=tests/evidence/c4-7b/behaviour.oracle.patch
    git apply --reverse --check "$patch"
    if git apply --check "$patch" 2>/dev/null; then
      echo 'Oracle unexpectedly forward-applies' >&2
      exit 1
    fi
    git apply --reverse "$patch"
    trap 'git apply "$patch"' EXIT
    set +e
    cargo test -p ifc-lite-wasm --lib c4_7b_ -- --nocapture > .c4-7b-mutation.log 2>&1
    result=$?
    set -e
    cat .c4-7b-mutation.log
    git apply "$patch"
    trap - EXIT
    # A compile failure is not observation: both witnesses must FAIL.
    test "$result" -eq 101
    grep -q '^test result: FAILED' .c4-7b-mutation.log
    grep -q 'c4_7b_parts_to_skip_reads_the_injected_layer_index_8341 \.\.\. FAILED' .c4-7b-mutation.log
    grep -q 'c4_7b_once_prepass_installs_the_columns_lazy_builds_would_scan_8341 \.\.\. FAILED' .c4-7b-mutation.log
    rm .c4-7b-mutation.log
    cargo test -p ifc-lite-wasm --lib c4_7b_
    echo 'C4_7B_ORACLE_CAUGHT'
    ;;
  measure)
    bash tests/evidence/c4-7b/measure.sh
    ;;
  *)
    echo "usage: $0 native|mutation|measure" >&2
    exit 64
    ;;
esac
