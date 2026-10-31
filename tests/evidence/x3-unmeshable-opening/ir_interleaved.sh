#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# X3 (#8385) perf cross-check, run through ifc-fleet from the clean head
# checkout. The base is exported once and both sides are built once on the
# same host (instructions.sh uses a per-tree target/phase-markers dir), then
# measured in three interleaved rounds on ISSUE_129, every phase. Round 1 keeps
# its callgrind dumps for ir_fndiff.py. X3_BASE overrides the base commit.
set -euo pipefail
head_dir=$PWD
base=$(git rev-parse --verify "${X3_BASE:-6eec58244d01852bae1134c54985a51acc43efa4}^{commit}")
fixture=${X3_IR_FIXTURE:-$HOME/build-workers/ifc-lite/tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc}
for dir in "$HOME"/build-workers/toolchains/valgrind-*/bin; do PATH="$dir:$PATH"; done
out=${X3_IR_OUT:-/tmp/x3-irdiff}
rm -rf "$out"; mkdir -p "$out/base-src"
git archive "$base" | tar -x -C "$out/base-src"
git -C "$out/base-src" init -q
git -C "$out/base-src" add -A
git -C "$out/base-src" -c user.name=x3 -c user.email=x3@invalid commit -qm base
echo "X3_IRDIFF head=$(git rev-parse HEAD) base=$base host=$(hostname)"
for round in 1 2 3; do
  for side in base head; do
    src=$head_dir; [[ $side == base ]] && src=$out/base-src
    keep=(); [[ $round == 1 ]] && keep=(--keep "$out/$side")
    (cd "$src" && bash scripts/perf/instructions.sh "$fixture" --json "${keep[@]}") > "$out/$side-$round.json"
    echo "X3_IRDIFF_ROUND $round $side $(python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["phases"]))' "$out/$side-$round.json")"
  done
done
python3 -I - "$out" <<'PY'
import json, sys
out = sys.argv[1]
bad = False
for r in (1, 2, 3):
    b = json.load(open(f'{out}/base-{r}.json')); h = json.load(open(f'{out}/head-{r}.json'))
    for k in ('meshes', 'vertices', 'triangles'):
        if b[k] != h[k]: bad = True; print(f'X3_IRDIFF_COUNTS round={r} {k} DIFFERENT')
    worst = max(h['phases'][p] / b['phases'][p] for p in b['phases'] if b['phases'][p])
    bad |= worst > 1.0005
    print(f'X3_IRDIFF_WORST round={r} {worst:.6f}')
print('X3_IRDIFF_VERDICT', 'FAIL' if bad else 'PASS (every round, every phase <= base x 1.0005)')
sys.exit(1 if bad else 0)
PY
echo "X3_IRDIFF_DONE dumps=$out/{base,head}/callgrind.out.9 (geometry phase)"
