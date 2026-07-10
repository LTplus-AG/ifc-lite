#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Symbolized flamegraph of the native pipeline on one fixture, via samply
# (https://github.com/mstange/samply -> `cargo install samply`). Opens the
# Firefox-profiler UI so parse/geometry hotspots are clickable down to the
# function. The `profiling` cargo profile keeps symbols + panic=unwind.
#
#   scripts/perf/flame.sh tests/models/ara3d/schependomlaan.ifc
#   scripts/perf/flame.sh tests/models/ara3d/AC20-FZK-Haus.ifc --iters 1
#
# Use --iters 1 for a single clean pass in the flamegraph (default 3 stacks
# three passes, useful for a warmer, denser sample).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

if ! command -v samply >/dev/null 2>&1; then
  echo "samply not found. Install it: cargo install samply" >&2
  exit 1
fi
if [ "$#" -lt 1 ]; then
  echo "usage: scripts/perf/flame.sh <file.ifc> [perf_probe args...]" >&2
  exit 2
fi

cargo build --profile profiling -p ifc-lite-processing --example perf_probe >&2
BIN="$ROOT/target/profiling/examples/perf_probe"
echo "samply record $BIN $*" >&2
exec samply record "$BIN" "$@"
