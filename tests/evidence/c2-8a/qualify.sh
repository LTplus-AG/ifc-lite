#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# C2-8 (#8263) base-vs-head qualification for the prism_cut split stack.
# Run ONLY through ifc-fleet, from a clean committed head checkout:
#
#   bash tests/evidence/c2-8a/qualify.sh identity      # output identity
#   bash tests/evidence/c2-8a/qualify.sh instructions  # per-phase Ir
#   bash tests/evidence/c2-8a/qualify.sh features      # gated failing set
#   bash tests/evidence/c2-8a/qualify.sh gates         # clippy/tests/ratchets/wasm32
#   bash tests/evidence/c2-8a/qualify.sh all           # identity + features + instructions
#
# C28_BASE overrides the base commit (default: main 70c91e8e61, the base of
# PR-1; each later PR passes its own stacked base). The base is exported with
# `git archive` next to the head checkout and both sides run the same harness.
set -euo pipefail
mode=${1:?usage: qualify.sh identity|instructions|features|gates|all}
base=$(git rev-parse --verify "${C28_BASE:-70c91e8e617402ea2ca8949117fa2acbe61d97b7}^{commit}")
head_dir=$PWD
fixtures=(
  tests/models/ara3d/AC20-FZK-Haus.ifc
  tests/models/ara3d/duplex.ifc
  tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc
)
echo "C28 mode=$mode head=$(git rev-parse HEAD) base=$base host=$(hostname)"
git diff --quiet && git diff --cached --quiet || { echo 'head checkout is dirty'; exit 2; }
rustc --version

if [[ $mode == all ]]; then
  # identity, features and instructions in sequence (one scratch at a time).
  status=0
  for sub in identity features instructions; do
    bash "$0" "$sub" || { echo "C28_ALL $sub FAILED"; status=1; }
  done
  exit $status
fi

if [[ $mode == gates ]]; then
  # Head-only gates; every step runs, the verdict lists each exit status.
  steps=(
    'cargo clippy --workspace --all-targets -- -D warnings'
    'cargo clippy -p ifc-lite-geometry --features retained-runtime --all-targets -- -D warnings'
    'cargo clippy -p ifc-lite-processing --features retained-runtime --all-targets -- -D warnings'
    'cargo test -p ifc-lite-geometry --lib --tests'
    'cargo test -p ifc-lite-geometry --features retained-runtime --lib --tests'
    'cargo test -p ifc-lite-processing --test module_size_ratchet --test function_length_ratchet'
    'cargo check --target wasm32-unknown-unknown -p ifc-lite-wasm'
    'cargo clippy --target wasm32-unknown-unknown -p ifc-lite-wasm --all-targets --features retained-browser -- -D warnings'
  )
  status=0
  results=()
  for step in "${steps[@]}"; do
    echo "C28_GATE_START $step"
    set +e
    bash -c "$step" > "$head_dir/.c2-8-gate.log" 2>&1
    rc=$?
    set -e
    tail -n 30 "$head_dir/.c2-8-gate.log"
    grep -E '^test result:|^error|^warning: unused' "$head_dir/.c2-8-gate.log" | sed 's/^/C28_GATE_LINE /' || true
    results+=("C28_GATE exit=$rc $step")
    [[ $rc == 0 ]] || status=1
  done
  rm -f "$head_dir/.c2-8-gate.log"
  printf '%s\n' "${results[@]}"
  exit $status
fi

export IFC_C28_FIXTURE_CACHE="${IFC_C28_FIXTURE_CACHE:-$HOME/build-workers/ifc-lite/tests/models}"
python3 -I - <<'PYFIX'
import os
from pathlib import Path
cache = Path(os.environ['IFC_C28_FIXTURE_CACHE'])
if cache.is_dir():
    for source in cache.rglob('*'):
        dest = Path('tests/models') / source.relative_to(cache)
        if source.is_file() and not dest.exists() and not dest.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(source.resolve())
PYFIX
for fixture in "${fixtures[@]}"; do
  [[ -f $fixture ]] || node scripts/fixtures/fetch-fixtures.mjs "${fixture#tests/models/}"
  [[ -f $fixture ]] || { echo "missing fixture $fixture"; exit 2; }
  echo "C28_FIXTURE $(sha256sum "$fixture")"
done

scratch="$head_dir/.c2-8-qualify"
[[ ! -e "$scratch" ]] || { echo 'qualify scratch already exists'; exit 1; }
mkdir -p "$scratch/base"
probe=rust/processing/examples/c2_8_identity_probe.rs
cleanup() {
  rm -f "$head_dir/$probe"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
git archive "$base" | tar -x -C "$scratch/base"
# instructions.sh labels its report with `git rev-parse`; give the export a repo.
git -C "$scratch/base" init -q
git -C "$scratch/base" add -A
git -C "$scratch/base" -c user.name=c28 -c user.email=c28@invalid commit -qm "base $base"

side_dir() { [[ $1 == base ]] && echo "$scratch/base" || echo "$head_dir"; }

case $mode in
identity)
  for side in base head; do
    src=$(side_dir "$side")
    cp "$head_dir/tests/evidence/c2-8a/identity_probe.rs" "$src/$probe"
    (cd "$src" && cargo build --profile profiling -p ifc-lite-processing --example c2_8_identity_probe >&2)
    bin="${CARGO_TARGET_DIR:-$src/target}/profiling/examples/c2_8_identity_probe"
    for fixture in "${fixtures[@]}"; do
      name=$(basename "$fixture" .ifc)
      out="$scratch/$side-$name"
      line=$("$bin" "$head_dir/$fixture" "$out" | grep '^C28_IDENTITY ')
      echo "C28_IDENTITY $side $name ${line#C28_IDENTITY }" | tee -a "$scratch/identity.txt"
    done
  done
  status=0
  for fixture in "${fixtures[@]}"; do
    name=$(basename "$fixture" .ifc)
    b=$(grep "^C28_IDENTITY base $name " "$scratch/identity.txt" | cut -d' ' -f4-)
    h=$(grep "^C28_IDENTITY head $name " "$scratch/identity.txt" | cut -d' ' -f4-)
    if [[ $b == "$h" ]] && cmp -s "$scratch/base-$name.diagnostics.json" "$scratch/head-$name.diagnostics.json"; then
      echo "C28_IDENTITY_VERDICT $name IDENTICAL"
    else
      echo "C28_IDENTITY_VERDICT $name DIFFERENT"
      diff "$scratch/base-$name.diagnostics.json" "$scratch/head-$name.diagnostics.json" | head -40 || true
      status=1
    fi
  done
  exit $status
  ;;
instructions)
  for dir in "$HOME"/build-workers/toolchains/valgrind-*/bin; do
    command -v valgrind >/dev/null || { [[ -x $dir/valgrind ]] && PATH="$dir:$PATH"; }
  done
  command -v valgrind >/dev/null || { echo 'valgrind (callgrind) is required'; exit 2; }
  valgrind --version
  for side in base head; do
    src=$(side_dir "$side")
    for fixture in "${fixtures[@]}"; do
      name=$(basename "$fixture" .ifc)
      json=$(cd "$src" && bash scripts/perf/instructions.sh "$head_dir/$fixture" --json)
      echo "$json" > "$scratch/$side-$name.ir.json"
      echo "C28_IR $side $name $(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$scratch/$side-$name.ir.json")"
    done
  done
  python3 -I - "$scratch" "${fixtures[@]}" <<'PY'
import json, os, sys
scratch, fixtures = sys.argv[1], sys.argv[2:]
worst, bad = 0.0, False
for fixture in fixtures:
    name = os.path.basename(fixture)[:-4]
    b = json.load(open(f'{scratch}/base-{name}.ir.json'))
    h = json.load(open(f'{scratch}/head-{name}.ir.json'))
    for key in ('meshes', 'vertices', 'triangles'):
        if b[key] != h[key]:
            bad = True
            print(f'C28_IR_COUNTS {name} {key} base={b[key]} head={h[key]} DIFFERENT')
    for phase, bv in b['phases'].items():
        hv = h['phases'][phase]
        ratio = hv / bv if bv else (1.0 if hv == 0 else float('inf'))
        worst = max(worst, ratio)
        over = ratio > 1.0005
        bad |= over
        print(f'C28_IR_PHASE {name} {phase} base={bv} head={hv} ratio={ratio:.6f}'
              f'{" OVER" if over else ""}')
print(f'C28_IR_VERDICT worst={worst:.6f} {"FAIL" if bad else "PASS (every phase <= base x 1.0005)"}')
sys.exit(1 if bad else 0)
PY
  ;;
features)
  for side in base head; do
    src=$(side_dir "$side")
    log="$scratch/$side-features.log"
    set +e
    (cd "$src" && cargo test -p ifc-lite-geometry --features csg_manifold_gate,csg_topology_gate,opening-perf-trace \
      --no-fail-fast -- --test-threads=4) > "$log" 2>&1
    rc=$?
    set -e
    grep -E '^test result:' "$log" | sed "s/^/C28_FEATURES_RESULT $side /"
    grep -E '^test .* \.\.\. FAILED$' "$log" | sed -E 's/^test (.*) \.\.\. FAILED$/\1/' | sort > "$scratch/$side-failing.txt"
    echo "C28_FEATURES $side exit=$rc failing=$(wc -l < "$scratch/$side-failing.txt")"
    sed "s/^/C28_FEATURES_FAILED $side /" "$scratch/$side-failing.txt"
    grep -q 'error\[E' "$log" && { echo "C28_FEATURES $side did not compile"; grep -A5 'error\[E' "$log" | head -40; exit 1; }
  done
  if cmp -s "$scratch/base-failing.txt" "$scratch/head-failing.txt"; then
    echo 'C28_FEATURES_VERDICT failing set identical to base'
  else
    echo 'C28_FEATURES_VERDICT failing set DIFFERS'
    diff "$scratch/base-failing.txt" "$scratch/head-failing.txt" || true
    exit 1
  fi
  ;;
*) echo "unknown mode $mode"; exit 2;;
esac
