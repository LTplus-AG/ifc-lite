#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# C2-7 (#8263) qualification. Run ONLY through ifc-fleet; no nested admission
# or retries. Shared by the c2-7a/b/c layers: C27_EVIDENCE names the layer's
# evidence directory (its oracle patch), C27_BASE the commit compared against.
set -euo pipefail
EVIDENCE=${C27_EVIDENCE:-tests/evidence/c2-7a}
BASE=${C27_BASE:-70c91e8e61}
FIXTURES=(
  tests/models/ara3d/AC20-FZK-Haus.ifc
  tests/models/ara3d/duplex.ifc
  tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc
)
PROCESSING_VOID_TESTS=(
  openings_consume_host issue_2019_void_order_invariance issue_3641_voiding_trap
  issue_5409_opening_display_colour issue_5410_redundant_opening_on_voided_profile
  issue_5739_local_frame_voided_wall issue_6940_opening_filling_a_profile_hole
  issue_8156_wall_43810_open_edges opening_filter_ignore_opaque
  module_size_ratchet function_length_ratchet
)
# Scratch lives under the ignored target/, so the task checkout stays clean
# for the worker's --require-clean admission of the next job.
SCRATCH_ROOT="$PWD/target/c2-7-scratch"
# A checkout-private target dir. The worker's shared cache lane is reused
# across checkouts, and cargo's mtime freshness then trusts a fingerprint
# another checkout wrote after this one was created: a mutation run there
# reported green tests from a binary built before the patch was applied.
export CARGO_TARGET_DIR="$PWD/target/c2-7-cargo"
PROBE=tests/evidence/c2-7a/identity_probe.rs
PROBE_AT=rust/processing/examples/c27_identity_probe.rs

# Export BASE into a scratch tree (removed on exit).
with_base() {
  mkdir -p "$SCRATCH_ROOT"
  scratch=$(mktemp -d "$SCRATCH_ROOT/base.XXXXXX")
  trap 'rm -rf -- "$scratch"' EXIT
  git archive "$BASE" | tar -x -C "$scratch"
}

fixtures() {
  pnpm fixtures "${FIXTURES[@]#tests/models/}" >&2
  for f in "${FIXTURES[@]}"; do test -s "$f"; done
}

# Build the injected identity probe in tree $1 with target dir $2.
build_probe() {
  cp "$PROBE" "$1/$PROBE_AT"
  (cd "$1" && CARGO_TARGET_DIR="$2" cargo build --release -p ifc-lite-processing --example c27_identity_probe)
  rm "$1/$PROBE_AT"
}

case "${1:-native}" in
  native)
    cargo clippy --workspace --all-targets -- -D warnings
    cargo clippy -p ifc-lite-geometry -p ifc-lite-processing --all-targets \
      --features ifc-lite-geometry/retained-runtime,ifc-lite-processing/retained-runtime -- -D warnings
    cargo check -p ifc-lite-geometry --features observability
    cargo test -p ifc-lite-geometry --lib --tests
    args=(); for t in "${PROCESSING_VOID_TESTS[@]}"; do args+=(--test "$t"); done
    cargo test -p ifc-lite-processing "${args[@]}"
    cargo check -p ifc-lite-geometry -p ifc-lite-wasm --target wasm32-unknown-unknown
    echo 'C27_NATIVE_GREEN'
    ;;
  features)
    # The special feature set's failing tests on head and on BASE.
    with_base
    run() { (cd "$1" && cargo test -p ifc-lite-geometry --no-fail-fast \
      --features csg_manifold_gate,csg_topology_gate,opening-perf-trace 2>&1 || true) \
      | grep -E '^test .* FAILED$' | sed 's/ \.\.\. FAILED$//' | sort -u; }
    head_set=$(run .)
    base_set=$(CARGO_TARGET_DIR="$scratch/target" run "$scratch")
    echo "head failing: ${head_set:-<none>}"
    echo "base failing: ${base_set:-<none>}"
    test "$head_set" = "$base_set"
    echo 'C27_FEATURE_SET_EQUAL'
    ;;
  identity)
    fixtures
    with_base
    head_target="${CARGO_TARGET_DIR:-$PWD/target}"
    build_probe "$PWD" "$head_target"
    build_probe "$scratch" "$scratch/target"
    status=0
    for f in "${FIXTURES[@]}"; do
      h=$("$head_target/release/examples/c27_identity_probe" "$f")
      b=$("$scratch/target/release/examples/c27_identity_probe" "$f")
      echo "head $h"
      echo "base $b"
      [[ "$h" == "$b" ]] || status=1
      # Not vacuous: the diagnostics must exist for these voided fixtures.
      grep -q '"diagnosticsPresent":true' <<<"$h" || status=1
    done
    git diff --exit-code
    test "$status" -eq 0
    echo 'C27_OUTPUT_IDENTICAL'
    ;;
  instructions)
    command -v valgrind >/dev/null
    fixtures
    with_base
    status=0
    for f in "${FIXTURES[@]}"; do
      h=$(bash scripts/perf/instructions.sh "$f" --json)
      b=$(cd "$scratch" && bash scripts/perf/instructions.sh "$OLDPWD/$f" --json)
      python3 -I - "$h" "$b" <<'PY' || status=1
import json, sys
h, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
worst = 0.0
for k, v in b['phases'].items():
    r = h['phases'][k] / v if v else 1.0
    worst = max(worst, r)
    print(f"{h['fixture']} {k}: base {v} head {h['phases'][k]} ratio {r:.6f}")
same = all(h[k] == b[k] for k in ('meshes', 'vertices', 'triangles'))
print(f"{h['fixture']} worst {worst:.6f} counts-identical {same}")
sys.exit(0 if worst <= 1.0005 and same else 1)
PY
    done
    test "$status" -eq 0
    echo 'C27_INSTRUCTIONS_WITHIN_1_0005'
    ;;
  mutation)
    patch="$EVIDENCE/behaviour.oracle.patch"
    tests=${C27_MUTATION_FILTER:-stage_order_tests}
    mkdir -p "$SCRATCH_ROOT"
    log="$SCRATCH_ROOT/mutation.log"
    git apply --reverse --check "$patch"
    if git apply --check "$patch" 2>/dev/null; then
      echo 'Oracle unexpectedly forward-applies' >&2
      exit 1
    fi
    git apply --reverse "$patch"
    trap 'git apply "$patch"' EXIT
    set +e
    cargo test -p ifc-lite-geometry --lib "$tests" > "$log" 2>&1
    result=$?
    set -e
    cat "$log"
    git apply "$patch"
    trap - EXIT
    # A compile failure is not observation: the witnesses must FAIL.
    test "$result" -eq 101
    grep -q '^test result: FAILED' "$log"
    git diff --exit-code
    cargo test -p ifc-lite-geometry --lib "$tests"
    echo 'C27_ORACLE_CAUGHT'
    ;;
  *)
    echo "usage: $0 native|features|identity|instructions|mutation" >&2
    exit 64
    ;;
esac
