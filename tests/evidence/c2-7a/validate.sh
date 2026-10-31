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
mkdir -p "$SCRATCH_ROOT"
# A checkout-private target dir. The worker's shared cache lane is reused
# across checkouts, and cargo's mtime freshness then trusts a fingerprint
# another checkout wrote after this one was created: a mutation run there
# reported green tests from a binary built before the patch was applied.
export CARGO_TARGET_DIR="$PWD/target/c2-7-cargo"
PROBE=tests/evidence/c2-7a/identity_probe.rs
PROBE_AT=rust/processing/examples/c27_identity_probe.rs
echo "C27 mode=${1:-native} head=$(git rev-parse HEAD) base=$BASE host=$(hostname)"

# Everything a mode creates is registered here before it is created, and one
# EXIT trap removes it on success, on failure and after a failed build.
CLEAN=()
cleanup() { for path in "${CLEAN[@]}"; do rm -rf -- "$path"; done; }
trap cleanup EXIT

# Export BASE into a scratch tree.
with_base() {
  scratch=$(mktemp -d "$SCRATCH_ROOT/base.XXXXXX")
  CLEAN+=("$scratch")
  git archive "$BASE" | tar -x -C "$scratch"
}

# Link the host's fixture cache into a tree's tests/models, as C2-8's
# qualify.sh does, so base and head see the same corpus. Prints the count.
FIXTURE_CACHE=${C27_FIXTURE_CACHE:-$HOME/build-workers/ifc-lite/tests/models}
link_fixtures() {
  python3 -I - "$1" "$FIXTURE_CACHE" <<'PY'
import sys
from pathlib import Path
root, cache = Path(sys.argv[1]), Path(sys.argv[2])
linked = 0
if cache.is_dir() and cache.resolve() != (root / 'tests/models').resolve():
    for source in cache.rglob('*'):
        dest = root / 'tests/models' / source.relative_to(cache)
        if source.is_file() and not dest.exists() and not dest.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(source.resolve())
            linked += 1
print(linked)
PY
}

fixtures() {
  link_fixtures "$PWD" >/dev/null
  for f in "${FIXTURES[@]}"; do
    [[ -s $f ]] || pnpm fixtures "${f#tests/models/}" >&2
    test -s "$f"
    echo "fixture $(sha256sum "$f")"
  done
}

# Build the injected identity probe in tree $1 with target dir $2. The probe
# is registered for removal before it is copied, so a failed build cleans up.
build_probe() {
  CLEAN+=("$1/$PROBE_AT")
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
    # The special feature set's failing tests on head and on BASE, both with the
    # same linked fixture corpus. An empty failing set is a valid, green result.
    with_base
    echo "corpus files linked: head $(link_fixtures "$PWD"), base $(link_fixtures "$scratch")"
    status=0
    for side in head base; do
      if [[ $side == head ]]; then dir=$PWD target=$CARGO_TARGET_DIR; else dir=$scratch target=$scratch/target; fi
      log="$SCRATCH_ROOT/features-$side.log"
      set +e
      (cd "$dir" && CARGO_TARGET_DIR="$target" cargo test -p ifc-lite-geometry --no-fail-fast \
        --features csg_manifold_gate,csg_topology_gate,opening-perf-trace) > "$log" 2>&1
      rc=$?
      set -e
      { grep -E '^test result:' "$log" || true; } | sed "s/^/$side /"
      { grep -E '^test .* \.\.\. FAILED$' "$log" || true; } | sed 's/ \.\.\. FAILED$//' | sort -u > "$log.failing"
      echo "$side cargo exit $rc, failing $(wc -l < "$log.failing")"
      # Neither a build failure nor a nonzero exit without a failing test is a
      # failing set; both make the comparison meaningless.
      if ! grep -q '^test result:' "$log"; then
        echo "$side produced no test result"; { grep -E -A5 '^error' "$log" || true; } | head -40; status=1
      elif [[ $rc != 0 && ! -s $log.failing ]]; then
        echo "$side exited $rc without a failing test"; status=1
      fi
    done
    echo "head failing: $(tr '\n' ' ' < "$SCRATCH_ROOT/features-head.log.failing")"
    echo "base failing: $(tr '\n' ' ' < "$SCRATCH_ROOT/features-base.log.failing")"
    cmp -s "$SCRATCH_ROOT/features-head.log.failing" "$SCRATCH_ROOT/features-base.log.failing" || status=1
    test "$status" -eq 0
    echo 'C27_FEATURE_SET_EQUAL'
    ;;
  identity)
    fixtures
    with_base
    build_probe "$PWD" "$CARGO_TARGET_DIR"
    build_probe "$scratch" "$scratch/target"
    status=0
    for f in "${FIXTURES[@]}"; do
      h=$("$CARGO_TARGET_DIR/release/examples/c27_identity_probe" "$f")
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
    hv = h['phases'][k]
    # A phase the base never ran has no ratio: zero against nonzero fails.
    r = hv / v if v else (1.0 if hv == 0 else float('inf'))
    worst = max(worst, r)
    print(f"{h['fixture']} {k}: base {v} head {hv} ratio {r:.6f}{' BASE-ZERO' if v == 0 else ''}")
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
    log="$SCRATCH_ROOT/mutation.log"
    git apply --reverse --check "$patch"
    if git apply --check "$patch" 2>/dev/null; then
      echo 'Oracle unexpectedly forward-applies' >&2
      exit 1
    fi
    git apply --reverse "$patch"
    trap 'git apply "$patch"; cleanup' EXIT
    set +e
    cargo test -p ifc-lite-geometry --lib "$tests" > "$log" 2>&1
    result=$?
    set -e
    cat "$log"
    git apply "$patch"
    trap cleanup EXIT
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
