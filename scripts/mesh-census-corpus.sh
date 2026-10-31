#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Run `mesh_census` over every .ifc fixture in tests/models/manifest.json up to
# a size cap, one process per model, and concatenate the rows in manifest
# order (#8190).
#
# Usage: scripts/mesh-census-corpus.sh <mesh_census binary> <models dir> <out.jsonl> [max MiB=200] [jobs=4]
# CENSUS_ARGS (e.g. --no-voids) is passed to every mesh_census run.
#
# Build the binary once per commit (`cargo build --release -p
# ifc-lite-processing --example mesh_census`) and copy it out of target/
# before switching commits, so base and branch can run side by side. Compare
# two outputs with scripts/mesh-census-compare.mjs. Per-model stderr (timing,
# panics) lands next to the output as <out>.d/<n>.err; a model that fails is
# listed in <out>.failed and the script exits 1, since a model failing on BOTH
# sides would otherwise be absent from both outputs and compare as unchanged.
# A model that runs but emits no meshes is listed in <out>.empty.
set -euo pipefail

bin=$(realpath "$1")
models=$(realpath "$2")
out=$3
max_mib=${4:-200}
jobs=${5:-4}
here=$(cd "$(dirname "$0")/.." && pwd)

work="$out.d"
rm -rf "$work"
mkdir -p "$work"
: > "$out.failed"

node -e '
  const m = require(process.argv[1]);
  const max = Number(process.argv[2]) * 1024 * 1024;
  m.files.filter((e) => e.path.endsWith(".ifc") && e.size <= max)
   .forEach((e, i) => console.log(`${String(i).padStart(4, "0")}\t${e.path}`));
' "$here/tests/models/manifest.json" "$max_mib" > "$work/list"

echo "$(wc -l < "$work/list") models, $jobs at a time" >&2

export bin models work out CENSUS_ARGS
# shellcheck disable=SC2016
xargs -P "$jobs" -I{} bash -c '
  n=${1%%$'"'"'\t'"'"'*}; path=${1#*$'"'"'\t'"'"'}
  "$bin" ${CENSUS_ARGS:-} "$models/$path" > "$work/$n.jsonl" 2> "$work/$n.err" || echo "$path" >> "$out.failed"
' _ {} < "$work/list"

[ -s "$work/list" ] || { echo "no models selected from the manifest" >&2; exit 1; }
cat "$work"/*.jsonl > "$out"
# Models that emitted no meshes leave no rows to compare: list them beside the
# output so mesh-census-compare.mjs can show them and catch a disagreement.
: > "$out.empty"
while IFS=$'\t' read -r n path; do
  [ -s "$work/$n.jsonl" ] || grep -qxF "$path" "$out.failed" || echo "$path" >> "$out.empty"
done < "$work/list"
# Model paths relative to the models dir, so base and branch runs from
# different checkouts key the same mesh identically.
sed -i "s#\"model\":\"$models/#\"model\":\"#" "$out"
echo "$(wc -l < "$out") meshes, $(wc -l < "$out.failed") failed models" >&2
if [ -s "$out.failed" ]; then
  echo "failed models (see $work/*.err):" >&2
  cat "$out.failed" >&2
  exit 1
fi
