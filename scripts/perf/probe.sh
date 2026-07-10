#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Build + run the native perf probe (per-phase parse-vs-geometry attribution).
# All args pass through to the `perf_probe` example.
#
#   scripts/perf/probe.sh --suite --census
#   scripts/perf/probe.sh tests/models/ara3d/schependomlaan.ifc --iters 5
#   scripts/perf/probe.sh --suite --json > /tmp/perf.json
#
# Add OBS=1 to build with `--features observability` (fills faceted_brep_time_ms).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

FEATURES=()
if [ "${OBS:-0}" = "1" ]; then
  FEATURES=(--features observability)
fi

# `${FEATURES[@]+"${FEATURES[@]}"}` expands to nothing when the array is empty
# without tripping `set -u` on macOS's default bash 3.2 (which treats an empty
# array expansion as an unbound variable; fixed in bash 4.4).
cargo build --profile profiling -p ifc-lite-processing --example perf_probe ${FEATURES[@]+"${FEATURES[@]}"} >&2
exec "$ROOT/target/profiling/examples/perf_probe" "$@"
