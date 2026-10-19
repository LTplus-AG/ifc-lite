# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm build:imported-geometry
imported_status=$?
node scripts/build-imported-geometry.mjs --verify
verify_status=$?
pnpm build:wasm
wasm_status=$?
git diff --stat -- packages/ifcx/src/generated packages/wasm/pkg/ifc-lite.d.ts
sha256sum packages/ifcx/src/generated/imported-geometry.ts packages/ifcx/src/generated/imported-geometry-static.js packages/ifcx/src/generated/imported-geometry-static.d.ts packages/ifcx/src/generated/imported-geometry.provenance.json packages/wasm/pkg/ifc-lite.d.ts
printf 'imported_generation_exit=%s imported_verify_exit=%s canonical_wasm_build_exit=%s\n' "$imported_status" "$verify_status" "$wasm_status"
for result in "$imported_status" "$verify_status" "$wasm_status"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
