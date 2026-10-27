#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Run inside one admitted fleet job. Never acquires a nested reservation.
set -euo pipefail
export RUSTUP_TOOLCHAIN=nightly-2025-11-15
export CI=1
head=$(git rev-parse HEAD)
base=${E2_BASE:-$(git rev-parse origin/main)}
isolated=
comparison=
cleanup() {
  if [ -n "$comparison" ]; then rm -rf "$comparison"; fi
  if [ -n "$isolated" ]; then rm -rf "$isolated"; fi
}
trap cleanup EXIT
# Fleet object transfer does not refresh shared remote-tracking refs. Keep the
# requested main pin in an owned repository, never rewrite a foreign job's ref.
if [ "$(git rev-parse origin/main)" != "$base" ]; then
  isolated=$(mktemp -d "${TMPDIR:-/tmp}/m1-e2-validation.XXXXXX")
  git init -q "$isolated"
  git -C "$isolated" fetch --quiet --no-tags "$PWD" "$head" "$base"
  git -C "$isolated" checkout --quiet --detach "$head"
  git -C "$isolated" update-ref refs/remotes/origin/main "$base"
  cd "$isolated"
fi
root=$PWD
printf 'E2 validation head=%s base=%s host=%s\n' "$head" "$base" "$(hostname)"
rustc --version
node --version
pnpm install --frozen-lockfile
run() { printf '\nRUN'; printf ' %q' "$@"; printf '\n'; "$@"; }
run cargo clippy --workspace --all-targets -- -D warnings
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-wasm --all-targets -- -D warnings
run cargo clippy --target wasm32-unknown-unknown -p ifc-lite-wasm --all-targets --features retained-browser -- -D warnings
run node scripts/retained-browser-runtime-tests.mjs
run cargo test --workspace
run cargo test -p ifc-lite-geometry --features retained-runtime
run cargo test -p ifc-lite-processing --features retained-runtime --lib element::session_retained
run cargo test -p ifc-lite-processing --features retained-runtime --test m1_executor
run cargo test -p ifc-lite-retained-native --features retained-runtime
run cargo test -p ifc-lite-wasm --features retained-browser --test m1_retained_model
run cargo test -p ifc-lite-wasm --features retained-browser --lib retained_browser
run node --test scripts/retained-browser-driver.test.mjs
run node scripts/check-test-revert-oracle.mjs --base origin/main --ci --json \
  --mutation tests/evidence/m1-e2-retained-model/behaviour.oracle.patch \
  --test rust/wasm-bindings/tests/m1_retained_model.rs
run node scripts/check-module-size.mjs
run node scripts/check-refwalk-guards.mjs
run node scripts/check-ci-path-coverage.mjs
run node scripts/check-test-wiring.mjs
run env BUILD_RETAINED=1 bash scripts/build-wasm.sh
run git diff --exit-code -- packages/wasm/pkg/ifc-lite.d.ts
# Preserve a compact generated type diff in the fleet log.
git diff -- packages/wasm/pkg-retained/ifc-lite.d.ts
sha256sum packages/wasm/pkg-retained/ifc-lite.d.ts
# Two fresh builds in one source path; refresh inputs without cleaning shared caches.
# The task-owned export is removed after comparison; Cargo uses the admitted cache.
comparison=$(mktemp -d "${TMPDIR:-/tmp}/m1-e2-identity.XXXXXX")
mkdir "$comparison/source"
for side in base branch; do
  if [ "$side" = base ]; then revision=$base; else revision=$head; fi
  git archive "$revision" | tar -x -C "$comparison/source"
  (
    cd "$comparison/source"
    find rust -name '*.rs' -exec touch {} +
    bash scripts/build-wasm.sh
  )
  cp "$comparison/source/packages/wasm/pkg/ifc-lite_bg.wasm" "$comparison/$side.wasm"
  cp "$comparison/source/packages/wasm/pkg/ifc-lite.js" "$comparison/$side.js"
  cp "$comparison/source/packages/wasm/pkg/ifc-lite.d.ts" "$comparison/$side.d.ts"
  # Only this script's disposable source, never the admitted checkout/cache.
  rm -rf "$comparison/source"
  mkdir "$comparison/source"
done
run node --input-type=module - "$comparison" <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliSize } from './scripts/perf-ratchet/measure-bundle.mjs';
import { allowedMax } from './scripts/perf-ratchet/compare.mjs';
const ceiling = JSON.parse(readFileSync('tests/perf-ratchets/bundle.json')).entries.find(e => e.id === 'engine-wasm-brotli');
for (const side of ['base', 'branch']) {
  const bytes = readFileSync(`${process.argv[2]}/${side}.wasm`);
  const brotli = brotliSize(bytes);
  console.log(JSON.stringify({ side, raw: bytes.length, brotli, sha256: createHash('sha256').update(bytes).digest('hex'), ceiling: ceiling.ceiling, allowed: allowedMax(ceiling) }));
  if (brotli > allowedMax(ceiling)) throw new Error('engine WASM bundle ratchet exceeded');
}
JS
run cmp "$comparison/base.wasm" "$comparison/branch.wasm"
run cmp "$comparison/base.js" "$comparison/branch.js"
run cmp "$comparison/base.d.ts" "$comparison/branch.d.ts"
rm -rf "$comparison"
printf 'E2_VALIDATION_PASS head=%s base=%s\n' "$head" "$base"
