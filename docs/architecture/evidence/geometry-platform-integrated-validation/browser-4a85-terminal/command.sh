# SPDX-License-Identifier: MPL-2.0
source "$HOME/build-workers/worker-env.sh" || exit $?
pnpm install --frozen-lockfile || exit $?
pnpm fixtures || exit $?
pnpm fixtures:check || exit $?
source_id=$(git rev-parse HEAD)
checkout_key=$(printf '%s' "$(pwd -P)" | sha256sum | cut -c1-12)
export IFCLITE_ADAPTER_BUILD="$CARGO_TARGET_DIR/ifclite-smlib/wasm-$source_id-$checkout_key"
bash native/smlib-adapter/qualify.sh wasm
wasm_status=$?
test -f "$IFCLITE_ADAPTER_BUILD/ifclite_smlib_browser.mjs" || exit 2
sdk=${SMLIB_SOURCE:-${IFCLITE_SDK_CACHE:-/tmp/ifclite-public-sdk-c9c5979}/usd-brep}
for crate in rust/geometry-runtime rust/processing rust/wasm-bindings; do
  node scripts/stage-retained-browser-assets.mjs --build "$IFCLITE_ADAPTER_BUILD" --sdk "$sdk" --out "$PWD/$crate/smlib" || exit $?
done
export WASM_BINDGEN_TEST_TIMEOUT=180
wasm-pack test --headless --chrome rust/geometry-runtime --lib
runtime_status=$?
wasm-pack test --headless --chrome rust/processing --lib session_retained
processing_status=$?
wasm-pack test --headless --chrome rust/wasm-bindings --lib retained_
api_status=$?
pnpm build:wasm
build_status=$?
git diff --exit-code -- packages/wasm/pkg/ifc-lite.d.ts
types_status=$?
node scripts/stage-retained-browser-assets.mjs --build "$IFCLITE_ADAPTER_BUILD" --sdk "$sdk" --out "$PWD/apps/viewer/public/smlib" || exit $?
pnpm exec playwright install chromium || exit $?
pnpm test:retained-browser
js_status=$?
pnpm typecheck
typecheck_status=$?
printf 'wasm_ctest_exit=%s browser_runtime_exit=%s browser_processing_exit=%s browser_api_exit=%s canonical_build_exit=%s generated_types_exit=%s browser_js_exit=%s root_typecheck_exit=%s\n' "$wasm_status" "$runtime_status" "$processing_status" "$api_status" "$build_status" "$types_status" "$js_status" "$typecheck_status"
for result in "$wasm_status" "$runtime_status" "$processing_status" "$api_status" "$build_status" "$types_status" "$js_status" "$typecheck_status"; do
  if [ "$result" -ne 0 ]; then exit "$result"; fi
done
