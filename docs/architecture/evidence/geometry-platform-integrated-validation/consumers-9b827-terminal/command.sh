# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm install --frozen-lockfile || exit $?
pnpm fixtures || exit $?
pnpm fixtures:check || exit $?
pnpm build:imported-geometry
imported_status=$?
node scripts/build-imported-geometry.mjs --verify
verify_status=$?
pnpm build:wasm
wasm_status=$?
git diff --exit-code -- packages/ifcx/src/generated packages/wasm/pkg/ifc-lite.d.ts
generated_status=$?
pnpm build
build_status=$?
pnpm test:wasm-contract
contract_status=$?
pnpm typecheck
typecheck_status=$?
pnpm test
test_status=$?
printf 'repeat_imported_exit=%s imported_verify_exit=%s canonical_wasm_exit=%s generated_diff_exit=%s root_build_exit=%s wasm_contract_exit=%s root_typecheck_exit=%s root_test_exit=%s\n' "$imported_status" "$verify_status" "$wasm_status" "$generated_status" "$build_status" "$contract_status" "$typecheck_status" "$test_status"
for result in "$imported_status" "$verify_status" "$wasm_status" "$generated_status" "$build_status" "$contract_status" "$typecheck_status" "$test_status"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
