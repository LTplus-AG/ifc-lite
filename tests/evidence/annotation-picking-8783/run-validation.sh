#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

set -euo pipefail
export NODE_OPTIONS=--max-old-space-size=8192
export TURBO_CONCURRENCY=1
pnpm install --frozen-lockfile --prefer-offline
pnpm typecheck
pnpm test --filter=@ifc-lite/renderer
pnpm build --filter=@ifc-lite/viewer
validation_logs="$(mktemp -d -t issue-8783-viewer.XXXXXX)"
export VALIDATION_LOGS="$validation_logs"
echo "Validation logs: $validation_logs"
pids=()
for shard in 0 1 2 3; do
  TEST_SHARDS=4 TEST_SHARD="$shard" pnpm test --filter=@ifc-lite/viewer > "${validation_logs}/shard-$shard.log" 2>&1 &
  pids+=("$!")
done
failed=0
for shard in 0 1 2 3; do
  if wait "${pids[$shard]}"; then rc=0; else rc=$?; failed=1; fi
  echo "viewer shard $shard exit $rc"
  rg 'tests [0-9]|pass [0-9]|fail [0-9]|skipped [0-9]|cancelled [0-9]|error TS|not ok|✖' "${validation_logs}/shard-$shard.log" || true
done
if [ "$failed" != 0 ]; then exit 1; fi
curl -fL --max-time 60 https://github.com/user-attachments/files/27644980/IFCAnnotationTest.zip -o "$validation_logs/model.zip"
python3 - <<'PY'
from zipfile import ZipFile
from pathlib import Path
import os
logs = Path(os.environ['VALIDATION_LOGS'])
with ZipFile(logs / 'model.zip') as z:
    (logs / 'IFC_Annotation.ifc').write_bytes(z.read('IFC_Annotation.ifc'))
PY
pnpm exec tsx --tsconfig apps/viewer/tsconfig.json --import ./apps/viewer/src/test/vite-module-hooks.mjs tests/evidence/annotation-picking-8783/model-oracle.mjs "$validation_logs/IFC_Annotation.ifc"
node scripts/pre-handoff.mjs
