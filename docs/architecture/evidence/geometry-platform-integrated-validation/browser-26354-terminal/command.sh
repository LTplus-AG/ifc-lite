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
browser_tools="$CARGO_TARGET_DIR/ifclite-browser-tools/chrome-153.0.8010.52"
mkdir -p "$browser_tools"
curl --fail --silent --show-error https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/linux64/chromedriver-linux64.zip -o "$browser_tools/driver.zip" || exit $?
curl --fail --silent --show-error https://storage.googleapis.com/chrome-for-testing-public/153.0.8010.52/linux64/chrome-linux64.zip -o "$browser_tools/chrome.zip" || exit $?
printf '7726029da262768fd8770212ac54296f4d31afe790a951f98d5580437da533b1  %s\n' "$browser_tools/driver.zip" | sha256sum --check --strict || exit $?
printf 'e66f66d4802a46d4a022667e668aa950e277cadbfbed4b3777915b47413a0ef9  %s\n' "$browser_tools/chrome.zip" | sha256sum --check --strict || exit $?
python3 - "$browser_tools" <<'DRIVER'
import sys,zipfile,json
from pathlib import Path
root=Path(sys.argv[1])
for name in ['driver','chrome']:
    with zipfile.ZipFile(root/(name+'.zip')) as archive:
        for entry in archive.infolist():
            path=Path(entry.filename)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('invalid browser archive path')
            if entry.is_dir(): continue
            target=root/path
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(archive.read(entry))
            mode=(entry.external_attr>>16)&0o777
            if mode: target.chmod(mode)
chrome=root/'chrome-linux64/chrome'
driver=root/'chromedriver-linux64/chromedriver'
chrome.chmod(0o755);driver.chmod(0o755)
(root/'webdriver.json').write_text(json.dumps({'goog:chromeOptions':{'binary':str(chrome),'w3c':False}})+'\n')
DRIVER
browser_driver="$browser_tools/chromedriver-linux64/chromedriver"
"$browser_tools/chrome-linux64/chrome" --version || exit $?
"$browser_driver" --version || exit $?
sha256sum "$browser_driver" "$browser_tools/chrome-linux64/chrome"
export WASM_BINDGEN_TEST_WEBDRIVER_JSON="$browser_tools/webdriver.json"
export WASM_BINDGEN_TEST_TIMEOUT=180
export RUST_BACKTRACE=1
export RUST_LOG=wasm_bindgen_test_runner=debug
wasm-pack test --headless --chromedriver "$browser_driver" rust/geometry-runtime --lib
runtime_status=$?
wasm-pack test --headless --chromedriver "$browser_driver" rust/processing --lib -- session_retained
processing_status=$?
wasm-pack test --headless --chromedriver "$browser_driver" rust/wasm-bindings --lib -- retained_
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
