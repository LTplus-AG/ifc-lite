#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# C4-7b (#8341) instruction counts and output identity, base vs head.
# Run ONLY through ifc-fleet. No nested admission, retries or guard overrides.
#
# The same harness (measure_tests.rs) is copied into the base export and the
# head checkout. Each (fixture, mode) runs once under callgrind, whole process
# (rayon helpers included). The measured cost of a mode is its total Ir minus
# its `-setup` twin, which runs the identical setup without the measured call.
set -euo pipefail
base=${C4_7B_BASE:-51d6e067a558c98dc2ad49be982e43cbed4e5c08}
head_dir=$PWD
fixtures=(
  rust/processing/tests/fixtures/c4_native_unsliced_layers_7782.ifc
  tests/models/issues/845_wall_elemented_case.ifc
  tests/models/ara3d/AC20-FZK-Haus.ifc
  tests/models/ara3d/duplex.ifc
  tests/models/ara3d/schependomlaan.ifc
)
# Pop provisions valgrind as a user toolchain rather than a system package.
for dir in "$HOME"/build-workers/toolchains/valgrind-*/bin; do
  command -v valgrind >/dev/null || { [[ -x $dir/valgrind ]] && PATH="$dir:$PATH"; }
done
command -v valgrind >/dev/null || { echo 'valgrind (callgrind) is required'; exit 2; }
valgrind --version

export IFC_C4_FIXTURE_CACHE="${IFC_C4_FIXTURE_CACHE:-$HOME/build-workers/ifc-lite/tests/models}"
python3 - <<'PYFIX'
import os
from pathlib import Path
cache = Path(os.environ['IFC_C4_FIXTURE_CACHE'])
if cache.is_dir():
    for source in cache.rglob('*'):
        dest = Path('tests/models') / source.relative_to(cache)
        if source.is_file() and not dest.exists() and not dest.is_symlink():
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.symlink_to(source.resolve())
PYFIX
node scripts/fixtures/fetch-fixtures.mjs
scratch="$head_dir/.c4-7b-measure"
[[ ! -e "$scratch" ]] || { echo 'measure scratch already exists'; exit 1; }
mkdir -p "$scratch/base"
# merge_layers_skip_test.rs's sliceable wall: three parts must be skipped.
awk '/^fn sliceable_multilayer_wall_ifc/{on=1;next} on&&/r#"ISO-10303-21;/{p=1} p{print} p&&/^END-ISO-10303-21;/{exit}' \
  rust/geometry/tests/merge_layers_skip_test.rs | sed 's/^.*r#"//' > "$scratch/sliceable_wall_parts.ifc"
grep -q IFCRELAGGREGATES "$scratch/sliceable_wall_parts.ifc" || { echo 'sliceable wall fixture not extracted'; exit 1; }
fixtures+=("${scratch#"$head_dir"/}/sliceable_wall_parts.ifc")
for fixture in "${fixtures[@]}"; do [[ -f $fixture ]] || { echo "missing fixture $fixture"; exit 2; }; done
wiring='rust/wasm-bindings/src/api/gpu_meshes/mod.rs'
cleanup() {
  git -C "$head_dir" checkout -- "$wiring"
  rm -f "$head_dir/rust/wasm-bindings/src/api/gpu_meshes/c4_7b_measure.rs"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
git archive "$base" | tar -x -C "$scratch/base"

results="$scratch/results.tsv"
: > "$results"
for side in base head; do
  src=$([[ $side == base ]] && echo "$scratch/base" || echo "$head_dir")
  cp "$head_dir/tests/evidence/c4-7b/measure_tests.rs" "$src/rust/wasm-bindings/src/api/gpu_meshes/c4_7b_measure.rs"
  printf '\n#[cfg(test)]\n#[path = "c4_7b_measure.rs"]\nmod c4_7b_measure;\n' >> "$src/$wiring"
  bin=$(cd "$src" && cargo test --release -p ifc-lite-wasm --lib --no-run --message-format=json \
    | python3 -c 'import json,sys
for line in sys.stdin:
    m = json.loads(line)
    if m.get("reason") == "compiler-artifact" and m.get("executable") and m["target"]["name"] == "ifc_lite_wasm":
        print(m["executable"])' | tail -1)
  if [[ ! -x $bin ]]; then
    (cd "$src" && cargo test --release -p ifc-lite-wasm --lib --no-run 2>&1 | grep -v '^warning: /' | tail -40)
    echo "no test binary for $side"; exit 1
  fi
  echo "C4_7B_BINARY $side $bin"
  for fixture in "${fixtures[@]}"; do
    path="$head_dir/$fixture"
    for mode in parts-setup parts once-setup once; do
      out="$scratch/$side-$(basename "$fixture")-$mode.cg"
      C4_7B_MODE=$mode C4_7B_FIXTURE=$path valgrind --tool=callgrind --callgrind-out-file="$out" \
        "$bin" api::gpu_meshes::c4_7b_measure::c4_7b_measure --exact --ignored --test-threads=1 --nocapture \
        > "$out.log" 2>&1 || { cat "$out.log"; exit 1; }
      grep -q '^test result: ok. 1 passed' "$out.log" || { cat "$out.log"; exit 1; }
      ir=$(sed -n 's/^summary: //p' "$out")
      printf '%s\t%s\t%s\t%s\t%s\n' "$side" "$(basename "$fixture")" "$mode" "$ir" \
        "$(grep -o 'C4_7B [a-z]*=[0-9a-f]*' "$out.log" || true)" >> "$results"
    done
    C4_7B_MODE=identity C4_7B_FIXTURE=$path "$bin" api::gpu_meshes::c4_7b_measure::c4_7b_measure --exact --ignored --nocapture \
      | sed -n "s/^C4_7B_IDENTITY /C4_7B_IDENTITY $side $(basename "$fixture") /p"
  done
done
echo 'C4_7B_IR side fixture mode total_ir marker'
sed 's/^/C4_7B_IR /' "$results"
python3 - "$results" <<'PY'
import sys
rows = {}
for line in open(sys.argv[1]):
    side, fixture, mode, ir, *_ = line.rstrip('\n').split('\t')
    rows[(side, fixture, mode)] = int(ir)
for fixture in dict.fromkeys(k[1] for k in rows):
    for mode in ('parts', 'once'):
        cost = {s: rows[(s, fixture, mode)] - rows[(s, fixture, mode + '-setup')] for s in ('base', 'head')}
        ratio = cost['head'] / cost['base'] if cost['base'] else float('nan')
        print(f"C4_7B_COST {fixture} {mode} base={cost['base']} head={cost['head']} "
              f"saved={cost['base'] - cost['head']} ratio={ratio:.4f}")
PY
