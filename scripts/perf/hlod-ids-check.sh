#!/usr/bin/env bash
# Spike driver for hlod-ids-check.mjs on a fleet host (no host-local paths).
#   build: install, wasm, viewer dist, synthetic campus model under .hlod-ids/
#   check: the untimed pixel check (run inside ifc-gpu-check / ifc-fleet run --gpu)
set -euo pipefail
cd "$(dirname "$0")/../.."
W=.hlod-ids
case "${1:-}" in
  build)
    pnpm install --frozen-lockfile
    pnpm build:wasm
    pnpm --filter viewer... build
    mkdir -p "$W/models"
    node scripts/perf/huge-geometry-gen.mjs --scenario mixed-campus --elements 20000 --out "$W/models"
    ls -la apps/viewer/dist/index.html "$W/models" ;;
  check)
    for m in "$W/models/mixed-campus-20k.ifc" apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc apps/viewer/public/samples/infra-bridge.ifc; do
      name=$(basename "$m" .ifc)
      echo "=== $name"
      node scripts/perf/hlod-ids-check.mjs --model "$m" --out "$W/out/$name" ${HLOD_PX:+--hlod-px "$HLOD_PX"} ${ZOOM:+--zoom "$ZOOM"} || echo "=== $name FAILED $?"
    done ;;
  *) echo "usage: $0 build|check" >&2; exit 2 ;;
esac
