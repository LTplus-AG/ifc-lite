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
# Link the fixture cache into the head's tests/models. os.walk(followlinks=True)
# descends into symlinked directories (e.g. tests/models/ara3d), which
# Path.rglob does not.
link_fixtures() {
  python3 -I - "$1" <<'PYFIX'
import os, sys
from pathlib import Path
cache = Path(os.environ['IFC_C28_FIXTURE_CACHE'])
root = Path(sys.argv[1])
if cache.is_dir():
    for dirpath, _dirs, files in os.walk(cache, followlinks=True):
        for name in files:
            source = Path(dirpath) / name
            dest = root / 'tests/models' / source.relative_to(cache)
            if source.is_file() and not dest.exists() and not dest.is_symlink():
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.symlink_to(source.resolve())
PYFIX
}

# Make DST's tests/models a mirror of SRC's final tree: manifest.json and other
# small files copied, every fixture a symlink to the file SRC resolves to.
mirror_models() {
  python3 -I - "$1" "$2" <<'PYMIRROR'
import os, shutil, sys
from pathlib import Path
src, dst = Path(sys.argv[1]) / 'tests/models', Path(sys.argv[2]) / 'tests/models'
shutil.rmtree(dst, ignore_errors=True)
for dirpath, _dirs, files in os.walk(src, followlinks=True):
    for name in files:
        source = Path(dirpath) / name
        if not source.exists():
            continue  # dangling link: neither side can read it
        dest = dst / source.relative_to(src)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if source.suffix.lower() == '.json' and source.stat().st_size < (1 << 22):
            shutil.copyfile(source, dest)
        else:
            dest.symlink_to(source.resolve())
PYMIRROR
}

# Sorted `relpath sha256` of every file under a tree's tests/models.
models_digest() {
  python3 -I - "$1" <<'PYDIGEST'
import hashlib, os, sys
from pathlib import Path
root = Path(sys.argv[1]) / 'tests/models'
rows = []
for dirpath, _dirs, files in os.walk(root, followlinks=True):
    for name in files:
        path = Path(dirpath) / name
        if not path.exists():
            continue
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        rows.append(f'{path.relative_to(root)} {h.hexdigest()}')
print('\n'.join(sorted(rows)))
PYDIGEST
}
link_fixtures "$head_dir"
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
# The base sees exactly the head's final fixture tree (cache links, fetched
# fixtures and the head's manifest.json).
mirror_models "$head_dir" "$scratch/base"

side_dir() { [[ $1 == base ]] && echo "$scratch/base" || echo "$head_dir"; }
# Each side builds into its OWN target dir. A shared CARGO_TARGET_DIR (the
# fleet worker's cache lane) let one side's build be satisfied by artifacts the
# other left behind, which makes a base-vs-head comparison vacuous.
side_target() { [[ $1 == base ]] && echo "$scratch/target" || echo "$head_dir/target/c2-8-cargo"; }

# Print, from a cargo JSON message stream, the ifc-lite-geometry library
# artifact (its manifest path proves which tree it came from, `fresh` whether it
# was compiled now) and the executable selected by $3 (target name or kind).
build_report() {
  python3 -I - "$1" "$2" "$3" <<'PYART'
import hashlib, json, sys
path, side, want = sys.argv[1:4]
exe = ''
for line in open(path, errors='replace'):
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if m.get('reason') != 'compiler-artifact':
        continue
    t = m['target']
    if t['name'] == 'ifc_lite_geometry' and 'lib' in t['kind'] and not m['profile']['test']:
        print(f"C28_BUILD {side} geometry-lib manifest={m['manifest_path']} fresh={m['fresh']} "
              f"rlib={next((f for f in m['filenames'] if f.endswith('.rlib')), '?')}", file=sys.stderr)
    if m.get('executable') and (t['name'] == want or (want == 'geometry-lib-test' and t['name'] == 'ifc_lite_geometry' and m['profile']['test'] and 'lib' in t['kind'])):
        exe = m['executable']
if exe:
    h = hashlib.sha256(open(exe, 'rb').read()).hexdigest()
    print(f'C28_BUILD {side} executable={exe} sha256={h}', file=sys.stderr)
print(exe)
PYART
}

case $mode in
identity)
  for side in base head; do
    src=$(side_dir "$side")
    cp "$head_dir/tests/evidence/c2-8a/identity_probe.rs" "$src/$probe"
    (cd "$src" && CARGO_TARGET_DIR="$(side_target "$side")" cargo build --profile profiling \
      -p ifc-lite-processing --example c2_8_identity_probe --message-format=json-render-diagnostics) \
      > "$scratch/$side-build.jsonl"
    bin=$(build_report "$scratch/$side-build.jsonl" "$side" c2_8_identity_probe 2>&1 >/dev/null | tee /dev/stderr | sed -n 's/^C28_BUILD .* executable=\([^ ]*\) .*/\1/p')
    [[ -x $bin && $bin == "$(side_target "$side")"/* ]] || { echo "C28_BUILD $side: no probe binary in its own target dir"; exit 1; }
    sha256sum "$bin" | cut -c1-64 > "$scratch/$side-bin.sha256"
    for fixture in "${fixtures[@]}"; do
      name=$(basename "$fixture" .ifc)
      out="$scratch/$side-$name"
      line=$("$bin" "$head_dir/$fixture" "$out" | grep '^C28_IDENTITY ')
      echo "C28_IDENTITY $side $name ${line#C28_IDENTITY }" | tee -a "$scratch/identity.txt"
    done
  done
  if cmp -s "$scratch/base-bin.sha256" "$scratch/head-bin.sha256"; then
    echo 'C28_BUILD base and head probe binaries are byte-identical: the comparison would be vacuous'
    exit 1
  fi
  echo "C28_BUILD probe binaries differ: base $(cat "$scratch/base-bin.sha256") head $(cat "$scratch/head-bin.sha256")"
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
  models_digest "$head_dir" > "$scratch/head-models.txt"
  models_digest "$scratch/base" > "$scratch/base-models.txt"
  echo "C28_MODELS head files=$(wc -l < "$scratch/head-models.txt") sha256=$(sha256sum < "$scratch/head-models.txt" | cut -c1-64)"
  echo "C28_MODELS base files=$(wc -l < "$scratch/base-models.txt") sha256=$(sha256sum < "$scratch/base-models.txt" | cut -c1-64)"
  if ! cmp -s "$scratch/base-models.txt" "$scratch/head-models.txt"; then
    echo 'C28_MODELS fixture trees DIFFER; refusing to compare feature runs'
    diff "$scratch/base-models.txt" "$scratch/head-models.txt" | head -40 || true
    exit 1
  fi
  declare -A rcs totals
  for side in base head; do
    src=$(side_dir "$side")
    log="$scratch/$side-features.log"
    target=$(side_target "$side")
    feats=csg_manifold_gate,csg_topology_gate,opening-perf-trace
    (cd "$src" && CARGO_TARGET_DIR="$target" cargo test -p ifc-lite-geometry --features "$feats" \
      --no-run --message-format=json-render-diagnostics) > "$scratch/$side-features-build.jsonl"
    exe=$(build_report "$scratch/$side-features-build.jsonl" "$side" geometry-lib-test 2>&1 >/dev/null | tee /dev/stderr | sed -n 's/^C28_BUILD .* executable=\([^ ]*\) .*/\1/p')
    [[ -x $exe && $exe == "$target"/* ]] || { echo "C28_BUILD $side: no geometry lib test binary in its own target dir"; exit 1; }
    sha256sum "$exe" | cut -c1-64 > "$scratch/$side-libtest.sha256"
    set +e
    (cd "$src" && CARGO_TARGET_DIR="$target" cargo test -p ifc-lite-geometry --features "$feats" \
      --no-fail-fast -- --test-threads=4) > "$log" 2>&1
    rc=$?
    set -e
    rcs[$side]=$rc
    grep -E '^test result:' "$log" | sed "s/^/C28_FEATURES_RESULT $side /"
    totals[$side]=$(python3 -I - "$log" <<'PYSUM'
import re, sys
t = [0, 0, 0, 0]
for line in open(sys.argv[1], errors='replace'):
    m = re.match(r'test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored', line)
    if m:
        t[0] += 1
        for i in range(3):
            t[i + 1] += int(m.group(i + 1))
print(f'binaries={t[0]} passed={t[1]} failed={t[2]} ignored={t[3]}')
PYSUM
)
    echo "C28_FEATURES_TOTALS $side ${totals[$side]}"
    { grep -E '^test .* \.\.\. FAILED$' "$log" || true; } | sed -E 's/^test (.*) \.\.\. FAILED$/\1/' | sort > "$scratch/$side-failing.txt"
    echo "C28_FEATURES $side exit=$rc failing=$(wc -l < "$scratch/$side-failing.txt")"
    sed "s/^/C28_FEATURES_FAILED $side /" "$scratch/$side-failing.txt"
    if grep -q 'error\[E' "$log"; then
      echo "C28_FEATURES $side did not compile"; grep -A5 'error\[E' "$log" | head -40; exit 1
    fi
  done
  status=0
  if cmp -s "$scratch/base-libtest.sha256" "$scratch/head-libtest.sha256"; then
    echo 'C28_BUILD base and head geometry lib test binaries are byte-identical: vacuous'
    status=1
  else
    echo "C28_BUILD geometry lib test binaries differ: base $(cat "$scratch/base-libtest.sha256") head $(cat "$scratch/head-libtest.sha256")"
  fi
  for side in base head; do
    # A nonzero exit with no named failing test is an abort (a crashed or
    # unbuilt test binary), not a comparable result.
    if [[ ${rcs[$side]} != 0 && ! -s $scratch/$side-failing.txt ]]; then
      echo "C28_FEATURES_VERDICT $side exited ${rcs[$side]} with no failing test named: INCONCLUSIVE"
      status=1
    fi
  done
  if [[ ${rcs[base]} != "${rcs[head]}" ]]; then
    echo "C28_FEATURES_VERDICT exit codes differ: base=${rcs[base]} head=${rcs[head]}"
    status=1
  fi
  if [[ ${totals[base]} != "${totals[head]}" ]]; then
    echo "C28_FEATURES_VERDICT totals differ: base ${totals[base]} / head ${totals[head]}"
    status=1
  fi
  if ! cmp -s "$scratch/base-failing.txt" "$scratch/head-failing.txt"; then
    echo 'C28_FEATURES_VERDICT failing set DIFFERS'
    diff "$scratch/base-failing.txt" "$scratch/head-failing.txt" || true
    status=1
  fi
  if [[ $status == 0 ]]; then
    echo "C28_FEATURES_VERDICT identical to base: exit ${rcs[head]}, ${totals[head]}, same failing set"
  fi
  exit $status
  ;;
*) echo "unknown mode $mode"; exit 2;;
esac
