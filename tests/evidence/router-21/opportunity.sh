#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# ROUTER-21 (#8385) opportunity: the phase-marker perf_probe that
# instructions.sh builds, run once more single-threaded under callgrind over
# ISSUE_129 without phase dumps, then the inclusive Ir and call counts of the
# opening-meshing functions. Run ONLY through ifc-fleet.
set -euo pipefail
VG="$HOME/build-workers/toolchains/valgrind-3.26.0/bin"
if [[ -d $VG ]]; then export PATH="$VG:$PATH"; fi
F=${1:-tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc}
CACHE=$HOME/build-workers/ifc-lite/tests/models
if [[ ! -s $F && -s $CACHE/${F#tests/models/} ]]; then
  mkdir -p "$(dirname "$F")"
  ln -s "$CACHE/${F#tests/models/}" "$F"
fi
[[ -s $F ]] || pnpm fixtures "${F#tests/models/}" >&2
echo "head=$(git rev-parse HEAD) host=$(hostname) fixture $(sha256sum "$F")"
OUT="$PWD/target/router-21-opportunity"
rm -rf "$OUT"
mkdir -p "$OUT"
bash scripts/perf/instructions.sh "$F" --json --keep "$OUT/phases" | tee "$OUT/phases.json"
BIN="$PWD/target/phase-markers/profiling/examples/perf_probe"
valgrind --tool=callgrind --callgrind-out-file="$OUT/whole.out" --dump-instr=no --dump-line=no \
  "$BIN" "$F" --iters 1 --single-thread --json > "$OUT/probe.json" 2> "$OUT/valgrind.log"
callgrind_annotate --inclusive=yes --threshold=100 "$OUT/whole.out" > "$OUT/inclusive.txt"
echo '--- head of inclusive report'
head -25 "$OUT/inclusive.txt"
echo '--- inclusive, opening/void functions (top 120)'
grep -E 'opening|openings|voids::|Classifier|drain_parts' "$OUT/inclusive.txt" | head -120 || true
callgrind_annotate --inclusive=yes --tree=caller --threshold=100 "$OUT/whole.out" > "$OUT/tree.txt"
for fn in 'OpeningChild::run' 'GeometryProgram::drain_parts' 'OpeningControl::drain' \
          'place_probe_parts' 'decision::classify' 'extend_opening_mesh_through_host' \
          'clean_opening_item' 'opening_bounds::evaluate'; do
  echo "## callers of $fn"
  grep -n -B12 -E "\* .*${fn}" "$OUT/tree.txt" | head -40 || true
done
echo OPPORTUNITY_DONE
