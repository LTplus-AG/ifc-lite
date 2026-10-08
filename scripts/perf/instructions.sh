#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Per-phase instruction counts for one fixture (#6958).
#
# Builds perf_probe with `--features phase-markers`, runs it single-threaded
# under `valgrind --tool=callgrind` (one pipeline run, `--iters 1`), and folds
# the per-marker dumps into parse / entity scan / lookup / preprocess /
# geometry / total instruction counts plus the mesh, vertex and triangle
# counts. Instruction counts do not depend on machine load, so unlike
# probe.sh/ab.sh this needs no quiet machine; it is ~60-100x slower than a
# native run (FZK-Haus ~6 s, ISSUE_129 a few minutes).
#
#   scripts/perf/instructions.sh tests/models/ara3d/AC20-FZK-Haus.ifc
#   scripts/perf/instructions.sh tests/models/ara3d/AC20-FZK-Haus.ifc --json
#
# Flags:
#   --json            print the machine-readable report (stdout)
#   --keep <dir>      keep the raw callgrind dumps and probe JSON in <dir>
#
# Output JSON: {fixture, commit, phases:{parseIr, entityScanIr, lookupIr,
# preprocessIr, geometryIr, totalIr}, outside, processIr, meshes, vertices,
# triangles}. Field semantics: scripts/perf/instructions-report.mjs.
# Requires valgrind (callgrind). `perf stat` is not used: it is unavailable
# under WSL and counts are only comparable within one counting tool.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

FIXTURE=""
JSON=0
KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift;;
    --keep) KEEP="${2:?--keep needs a directory}"; shift 2;;
    -h|--help) sed -n '2,28p' "$0"; exit 0;;
    -*) echo "instructions.sh: unknown flag $1" >&2; exit 2;;
    *)
      if [ -n "$FIXTURE" ]; then
        echo "instructions.sh: pass exactly one fixture" >&2; exit 2
      fi
      FIXTURE="$1"; shift;;
  esac
done
if [ -z "$FIXTURE" ]; then
  echo "instructions.sh: pass one fixture path (see --help)" >&2
  exit 2
fi
if [ ! -f "$FIXTURE" ]; then
  echo "instructions.sh: fixture not found: $FIXTURE (fetch it first, e.g. \`pnpm fixtures ${FIXTURE#tests/models/}\`)" >&2
  exit 2
fi
if ! command -v valgrind >/dev/null 2>&1; then
  echo "instructions.sh: valgrind is required (apt install valgrind)" >&2
  exit 2
fi

if git diff --quiet && git diff --cached --quiet; then
  COMMIT="$(git rev-parse --short HEAD)"
else
  COMMIT="$(git rev-parse --short HEAD)+dirty"
fi

# Its own target directory: the feature changes ifc-lite-processing, so
# sharing target/ with probe.sh would rebuild (and relink with LTO) on every
# switch, and would swap the binary under a concurrent probe.sh run.
MARKER_TARGET="$ROOT/target/phase-markers"
CARGO_TARGET_DIR="$MARKER_TARGET" \
  cargo build --profile profiling -p ifc-lite-processing --example perf_probe --features phase-markers >&2
BIN="$MARKER_TARGET/profiling/examples/perf_probe"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ifc-instructions.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# One run, one thread: every phase marker fires exactly once and the counts
# do not depend on how rayon happened to split the work.
valgrind --tool=callgrind --callgrind-out-file="$WORK/callgrind.out" \
  --dump-before='ifc_lite_processing::processor::phase_marks::*' \
  --dump-instr=no --dump-line=no \
  "$BIN" "$FIXTURE" --iters 1 --single-thread --json \
  > "$WORK/probe.json" 2> "$WORK/valgrind.log" || {
    echo "instructions.sh: the callgrind run failed; last lines:" >&2
    tail -n 20 "$WORK/valgrind.log" >&2
    exit 1
  }

if [ -n "$KEEP" ]; then
  mkdir -p "$KEEP"
  cp "$WORK"/* "$KEEP"/
fi

REPORT_ARGS=(--dumps "$WORK/callgrind.out" --probe "$WORK/probe.json" --fixture "$FIXTURE" --commit "$COMMIT")
[ "$JSON" = 1 ] && REPORT_ARGS+=(--json)
node "$ROOT/scripts/perf/instructions-report.mjs" "${REPORT_ARGS[@]}"
