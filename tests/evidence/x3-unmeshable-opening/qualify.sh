#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# X3 / ROUTER-37 (#8385) base-vs-head qualification, adapted from the C2-8a
# harness (#8263). Run ONLY through ifc-fleet, from a clean committed head
# checkout:
#
#   bash tests/evidence/x3-unmeshable-opening/qualify.sh identity      # output identity
#   bash tests/evidence/x3-unmeshable-opening/qualify.sh instructions  # per-phase Ir
#   bash tests/evidence/x3-unmeshable-opening/qualify.sh features      # gated failing set
#   bash tests/evidence/x3-unmeshable-opening/qualify.sh gates         # clippy/tests/ratchets/wasm32
#   bash tests/evidence/x3-unmeshable-opening/qualify.sh all           # identity + features + instructions
#
# X3_BASE overrides the base commit (default: main 6eec58244d, this PR's
# base). The base is exported with `git archive` next to the head checkout and
# both sides run the same harness. Identity hashes the full serialized output,
# including every instance record's contents, plus the diagnostics.
set -euo pipefail
mode=${1:?usage: qualify.sh identity|instructions|features|gates|all}
base=$(git rev-parse --verify "${X3_BASE:-6eec58244d01852bae1134c54985a51acc43efa4}^{commit}")
head_dir=$PWD
fixtures=(
  tests/models/ara3d/AC20-FZK-Haus.ifc
  tests/models/ara3d/duplex.ifc
  tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc
)
echo "X3 mode=$mode head=$(git rev-parse HEAD) base=$base host=$(hostname)"
git diff --quiet && git diff --cached --quiet || { echo 'head checkout is dirty'; exit 2; }
rustc --version

if [[ $mode == all ]]; then
  # identity, features and instructions in sequence (one scratch at a time).
  status=0
  for sub in identity features instructions; do
    bash "$0" "$sub" || { echo "X3_ALL $sub FAILED"; status=1; }
  done
  exit $status
fi

export IFC_X3_FIXTURE_CACHE="${IFC_X3_FIXTURE_CACHE:-$HOME/build-workers/ifc-lite/tests/models}"
# Link the fixture cache into a tree's tests/models (head now, the base export
# below), so both sides of the gated-feature run see the same corpus.
link_fixtures() {
  python3 -I - "$1" <<'PYFIX'
import os, sys
from pathlib import Path
cache = Path(os.environ['IFC_X3_FIXTURE_CACHE'])
root = Path(sys.argv[1])
if cache.is_dir():
    for source in cache.rglob('*'):
        dest = root / 'tests/models' / source.relative_to(cache)
        if source.is_file() and not dest.exists() and not dest.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(source.resolve())
PYFIX
}
link_fixtures "$head_dir"
for fixture in "${fixtures[@]}"; do
  [[ -f $fixture ]] || node scripts/fixtures/fetch-fixtures.mjs "${fixture#tests/models/}"
  [[ -f $fixture ]] || { echo "missing fixture $fixture"; exit 2; }
  echo "X3_FIXTURE $(sha256sum "$fixture")"
done

# Head-only gates run with the fixture corpus linked, so fixture tests run.
if [[ $mode == gates ]]; then
  # Head-only gates; every step runs, the verdict lists each exit status.
  steps=(
    'cargo clippy --workspace --all-targets -- -D warnings'
    'cargo clippy -p ifc-lite-geometry --features retained-runtime --all-targets -- -D warnings'
    'cargo clippy -p ifc-lite-processing --features retained-runtime --all-targets -- -D warnings'
    'cargo test -p ifc-lite-geometry --lib --tests'
    'cargo test -p ifc-lite-geometry --features retained-runtime --lib --tests'
    'cargo test -p ifc-lite-processing'
    'cargo test -p ifc-lite-processing --features retained-runtime --lib --tests'
    'cargo check --target wasm32-unknown-unknown -p ifc-lite-wasm'
    'cargo clippy --target wasm32-unknown-unknown -p ifc-lite-wasm --all-targets --features retained-browser -- -D warnings'
  )
  status=0
  results=()
  for step in "${steps[@]}"; do
    echo "X3_GATE_START $step"
    set +e
    bash -c "$step" > "$head_dir/.x3-gate.log" 2>&1
    rc=$?
    set -e
    tail -n 30 "$head_dir/.x3-gate.log"
    grep -E '^test result:|^error|^warning: unused' "$head_dir/.x3-gate.log" | sed 's/^/X3_GATE_LINE /' || true
    results+=("X3_GATE exit=$rc $step")
    [[ $rc == 0 ]] || status=1
  done
  rm -f "$head_dir/.x3-gate.log"
  printf '%s\n' "${results[@]}"
  exit $status
fi


scratch="$head_dir/.x3-qualify"
[[ ! -e "$scratch" ]] || { echo 'qualify scratch already exists'; exit 1; }
mkdir -p "$scratch/base"
probe=rust/processing/examples/x3_identity_probe.rs
cleanup() {
  rm -f "$head_dir/$probe"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
git archive "$base" | tar -x -C "$scratch/base"
# instructions.sh labels its report with `git rev-parse`; give the export a repo.
git -C "$scratch/base" init -q
git -C "$scratch/base" add -A
git -C "$scratch/base" -c user.name=x3 -c user.email=x3@invalid commit -qm "base $base"
link_fixtures "$scratch/base"

side_dir() { [[ $1 == base ]] && echo "$scratch/base" || echo "$head_dir"; }

case $mode in
identity)
  for side in base head; do
    src=$(side_dir "$side")
    cp "$head_dir/tests/evidence/x3-unmeshable-opening/identity_probe.rs" "$src/$probe"
    (cd "$src" && cargo build --profile profiling -p ifc-lite-processing --example x3_identity_probe >&2)
    bin="${CARGO_TARGET_DIR:-$src/target}/profiling/examples/x3_identity_probe"
    for fixture in "${fixtures[@]}"; do
      name=$(basename "$fixture" .ifc)
      out="$scratch/$side-$name"
      line=$("$bin" "$head_dir/$fixture" "$out" | grep '^X3_IDENTITY ')
      echo "X3_IDENTITY $side $name ${line#X3_IDENTITY }" | tee -a "$scratch/identity.txt"
    done
  done
  status=0
  for fixture in "${fixtures[@]}"; do
    name=$(basename "$fixture" .ifc)
    b=$(grep "^X3_IDENTITY base $name " "$scratch/identity.txt" | cut -d' ' -f4-)
    h=$(grep "^X3_IDENTITY head $name " "$scratch/identity.txt" | cut -d' ' -f4-)
    # Mesh payload, instances and every other output hash must be identical;
    # only diagnosticsSha256 may move, and only because of schemaVersion 3 -> 4
    # (#8385 X3), which the normalised comparison below proves.
    verdict=$(python3 -I - "$b" "$h" "$scratch/base-$name.diagnostics.json" "$scratch/head-$name.diagnostics.json" <<'PYID'
import json, sys
b, h = json.loads(sys.argv[1]), json.loads(sys.argv[2])
bd, hd = json.load(open(sys.argv[3])), json.load(open(sys.argv[4]))
out = []
for key in sorted(set(b) | set(h)):
    if key != 'diagnosticsSha256' and b.get(key) != h.get(key):
        out.append(f'output field {key} base={b.get(key)} head={h.get(key)}')
def versions(stats):
    g = stats.get('geometry_diagnostics') or stats.get('geometryDiagnostics')
    return g.get('schemaVersion') if isinstance(g, dict) else None
bv, hv = versions(bd), versions(hd)
def normalise(stats):
    stats = json.loads(json.dumps(stats))
    for key in ('geometry_diagnostics', 'geometryDiagnostics'):
        if isinstance(stats.get(key), dict):
            stats[key]['schemaVersion'] = 'NORMALISED'
    return stats
if normalise(bd) != normalise(hd):
    out.append('diagnostics differ beyond schemaVersion')
if (bv, hv) not in ((3, 4), (None, None)):
    out.append(f'schemaVersion base={bv} head={hv}, expected 3 -> 4')
print('IDENTICAL_EXCEPT_SCHEMA_VERSION %s->%s' % (bv, hv) if not out else 'DIFFERENT: ' + '; '.join(out))
PYID
)
    echo "X3_IDENTITY_VERDICT $name $verdict"
    if [[ $verdict != IDENTICAL_EXCEPT_SCHEMA_VERSION* ]]; then
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
      echo "X3_IR $side $name $(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$scratch/$side-$name.ir.json")"
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
            print(f'X3_IR_COUNTS {name} {key} base={b[key]} head={h[key]} DIFFERENT')
    for phase, bv in b['phases'].items():
        hv = h['phases'][phase]
        ratio = hv / bv if bv else (1.0 if hv == 0 else float('inf'))
        worst = max(worst, ratio)
        over = ratio > 1.0005
        bad |= over
        print(f'X3_IR_PHASE {name} {phase} base={bv} head={hv} ratio={ratio:.6f}'
              f'{" OVER" if over else ""}')
print(f'X3_IR_VERDICT worst={worst:.6f} {"FAIL" if bad else "PASS (every phase <= base x 1.0005)"}')
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
    grep -E '^test result:' "$log" | sed "s/^/X3_FEATURES_RESULT $side /"
    { grep -E '^test .* \.\.\. FAILED$' "$log" || true; } | sed -E 's/^test (.*) \.\.\. FAILED$/\1/' | sort > "$scratch/$side-failing.txt"
    echo "X3_FEATURES $side exit=$rc failing=$(wc -l < "$scratch/$side-failing.txt")"
    sed "s/^/X3_FEATURES_FAILED $side /" "$scratch/$side-failing.txt"
    if grep -q 'error\[E' "$log"; then
      echo "X3_FEATURES $side did not compile"; grep -A5 'error\[E' "$log" | head -40; exit 1
    fi
    echo "$rc" > "$scratch/$side-rc.txt"
    grep -E '^test result:' "$log" | python3 -I -c '
import re, sys
t = [0, 0, 0]
for line in sys.stdin:
    for i, k in enumerate(("passed", "failed", "ignored")):
        m = re.search(r"(\d+) " + k, line)
        t[i] += int(m.group(1)) if m else 0
print(*t)' > "$scratch/$side-totals.txt"
    { grep -E '^test .* \.\.\. (ok|FAILED|ignored)$' "$log" || true; } | sort > "$scratch/$side-outcomes.txt"
    echo "X3_FEATURES_TOTALS $side passed/failed/ignored=$(cat "$scratch/$side-totals.txt")"
  done
  # A binary that aborts before printing FAILED leaves an empty failing set, so
  # also require equal exit codes, equal failed/ignored totals, no base test
  # missing from head, and the passed delta to be exactly head's new ok tests.
  python3 -I - "$scratch" <<'PYFEAT'
import sys
s = sys.argv[1]
read = lambda f: open(f'{s}/{f}').read().split()
brc, hrc = read('base-rc.txt'), read('head-rc.txt')
bp, bf, bi = map(int, read('base-totals.txt'))
hp, hf, hi = map(int, read('head-totals.txt'))
from collections import Counter
bo = Counter(open(f'{s}/base-outcomes.txt').read().splitlines())
ho = Counter(open(f'{s}/head-outcomes.txt').read().splitlines())
missing, added = bo - ho, ho - bo
added_ok = sum(n for line, n in added.items() if line.endswith('... ok'))
bad = []
if brc != hrc: bad.append(f'exit codes base={brc} head={hrc}')
if (bf, bi) != (hf, hi): bad.append(f'failed/ignored base={bf}/{bi} head={hf}/{hi}')
if missing: bad.append(f'{sum(missing.values())} base test outcome(s) missing or changed in head: {sorted(missing)[:10]}')
if added and added_ok != sum(added.values()): bad.append(f'new head outcomes not all ok: {sorted(added)[:10]}')
if hp - bp != added_ok: bad.append(f'passed delta {hp - bp} != new ok tests {added_ok}')
print(f'X3_FEATURES_NEW_TESTS {added_ok}')
for b in bad: print(f'X3_FEATURES_MISMATCH {b}')
sys.exit(1 if bad else 0)
PYFEAT
  if cmp -s "$scratch/base-failing.txt" "$scratch/head-failing.txt"; then
    echo 'X3_FEATURES_VERDICT failing set identical to base (exit codes and totals checked)'
  else
    echo 'X3_FEATURES_VERDICT failing set DIFFERS'
    diff "$scratch/base-failing.txt" "$scratch/head-failing.txt" || true
    exit 1
  fi
  ;;
*) echo "unknown mode $mode"; exit 2;;
esac
