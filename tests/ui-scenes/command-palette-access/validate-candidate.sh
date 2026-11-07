#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Run from repo root inside ONE admitted fleet job. Full root graph, no local package bypass.
set -euo pipefail
logs="$PWD/.palette-access-validation"
mkdir -p "$logs"
printf 'source: %s\ntree: %s\nlogs: %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD^{tree})" "$logs"
inherited_node_options="${NODE_OPTIONS-}"
export NODE_OPTIONS="${inherited_node_options:---max-old-space-size=8192}"
export TURBO_CONCURRENCY=1
pnpm install --frozen-lockfile --prefer-offline
if pnpm typecheck >"$logs/typecheck.log" 2>&1; then tail -12 "$logs/typecheck.log";
else tail -150 "$logs/typecheck.log"; exit 1; fi
if pnpm build:e2e >"$logs/build.log" 2>&1; then tail -12 "$logs/build.log";
else tail -150 "$logs/build.log"; exit 1; fi
unset TEST_PATTERN
# Each root Turbo invocation retains prerequisite builds and receives its exact shard.
export NODE_OPTIONS="${inherited_node_options:---max-old-space-size=4096}"
pids=()
for shard in 0 1 2 3; do
  TEST_SHARDS=4 TEST_SHARD="$shard" pnpm test --filter=@ifc-lite/viewer >"$logs/viewer-$shard.log" 2>&1 &
  pids+=("$!")
done
failed=0
for shard in 0 1 2 3; do
  if wait "${pids[$shard]}"; then result=0; else result=$?; failed=1; fi
  printf 'viewer shard %s/4 exit %s\n' "$shard" "$result"
  tail -24 "$logs/viewer-$shard.log"
  if [ "$result" -ne 0 ]; then
    rg -n -A 22 'not ok|failureType:|error:|ERR_ASSERTION|tests |pass |fail |skipped ' "$logs/viewer-$shard.log" | tail -180 || true
  fi
done
# Full-suite acceptance requires all four shard receipts, including their skip counts.
exit "$failed"
