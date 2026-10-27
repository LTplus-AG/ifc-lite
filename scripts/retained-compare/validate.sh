#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# One admitted fleet batch. No nested reservations; no archives in the repository.
set -euo pipefail
root=$PWD
head=$(git rev-parse HEAD)
base=${F_BASE:?Set F_BASE to the captured origin/main commit}
export RUSTUP_TOOLCHAIN=nightly-2025-11-15
export CI=1
scratch=$(mktemp -d "${TMPDIR:-/tmp}/m1-f-validation.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
printf 'F_VALIDATION host=%s head=%s base=%s scratch=%s\n' "$(hostname)" "$head" "$base" "$scratch"
node --version
rustc --version
pnpm install --frozen-lockfile
# A private checkout owns the origin/main pin used by the oracle. The fleet's
# shared remote-tracking refs are not overwritten.
git cat-file -e "$base" || git fetch origin "$base"
mkdir "$scratch/source"
for side in base branch; do
  if [ "$side" = base ]; then revision=$base; else revision=$head; fi
  git archive "$revision" | tar -x -C "$scratch/source"
  (
    cd "$scratch/source"
    # Force Cargo to reconsider source in this identical path; do not clean a
    # shared target or touch another job's artifacts.
    find rust -name '*.rs' -exec touch {} +
    bash scripts/build-wasm.sh
    cp packages/wasm/pkg/ifc-lite_bg.wasm "$scratch/$side.wasm"
    cp packages/wasm/pkg/ifc-lite.js "$scratch/$side.js"
    cp packages/wasm/pkg/ifc-lite.d.ts "$scratch/$side.d.ts"
    wc -c "$scratch/$side.wasm" "$scratch/$side.js" "$scratch/$side.d.ts"
    sha256sum "$scratch/$side.wasm" "$scratch/$side.js" "$scratch/$side.d.ts"
    if [ "$side" = base ]; then
      pnpm install --frozen-lockfile
      pnpm build --filter=@ifc-lite/cli --concurrency=1
      node --input-type=module - "$scratch/golden.json" <<'JS'
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const result = {};
for (const model of ['tests/fixtures/synthetic-retained/f-c-extrusion.ifc', 'rust/geometry/tests/fixtures/mapped_instances_site_rotated.ifc']) {
  const cli = spawnSync(process.execPath, ['packages/cli/dist/index.js', 'export', model, '--format', 'obj'], { maxBuffer: 32 * 1024 * 1024 });
  if (cli.status !== 0) throw new Error(cli.stderr.toString());
  result[model] = createHash('sha256').update(cli.stdout).digest('hex');
}
writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
console.log('EXACT_MAIN_GOLDEN ' + JSON.stringify(result));
JS
    fi
  )
  rm -rf "$scratch/source"
  mkdir "$scratch/source"
done
for suffix in wasm js d.ts; do cmp "$scratch/base.$suffix" "$scratch/branch.$suffix"; done
printf 'DEFAULT_BUNDLE_IDENTITY PASS\n'
# Check the committed pins against freshly generated MAIN bytes only.
cmp "$scratch/golden.json" tests/fixtures/cli-retained/exact-obj-sha256.json
BUILD_RETAINED=1 bash scripts/build-wasm.sh
git diff --exit-code -- packages/wasm/pkg/ifc-lite.d.ts
pnpm build --filter=@ifc-lite/cli --concurrency=1
pnpm test --filter=@ifc-lite/cli --concurrency=1
node --test scripts/retained-compare/inert.test.mjs scripts/retained-compare/metrics.test.mjs
cargo clippy --workspace --all-targets -- -D warnings
# Own a disposable Git checkout for the oracle; share the already-built deps.
git clone --quiet --no-hardlinks --shared "$root" "$scratch/oracle"
git -C "$scratch/oracle" update-ref refs/remotes/origin/main "$base"
# The oracle's library prepares its own working directories using this source.
(cd "$scratch/oracle" && pnpm install --frozen-lockfile)
(cd "$scratch/oracle" && pnpm build --filter=@ifc-lite/cli --concurrency=1)
(cd "$scratch/oracle" && node scripts/check-test-revert-oracle.mjs --base origin/main --ci --json \
  --mutation tests/evidence/m1-f-cli-retained/behaviour.oracle.patch --test packages/cli/src/commands/export-retained.test.ts)
node scripts/check-ci-path-coverage.mjs
node scripts/check-test-wiring.mjs
node scripts/check-module-size.mjs
node scripts/check-refwalk-guards.mjs
node scripts/check-source-text-assertions.mjs
node --test scripts/smlib-node-transport.test.mjs scripts/stage-cli-retained-engine.test.mjs
printf 'F_VALIDATION_PASS head=%s base=%s\n' "$head" "$base"
