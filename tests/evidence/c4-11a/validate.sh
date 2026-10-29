#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
# Invoke ONLY through ifc-fleet; never from an existing reservation launcher.
set -euo pipefail
case "${1:-native}" in
  native)
    cargo test -p ifc-lite-wasm c4_11a -- --nocapture
    cargo test -p ifc-lite-wasm c4_0_native_browser_parity -- --nocapture
    cargo test -p ifc-lite-wasm c4_10a -- --nocapture
    cargo test -p ifc-lite-processing --test module_size_ratchet --test function_length_ratchet --test positional_read_ratchet
    cargo clippy --workspace --all-targets -- -D warnings
    ;;
  mutation)
    patch=tests/evidence/c4-11a/behaviour.oracle.patch
    git apply --reverse --check "$patch"
    git apply --reverse "$patch"
    trap 'git apply "$patch"' EXIT
    set +e
    cargo test -p ifc-lite-wasm c4_11a -- --nocapture > /tmp/c4-11a-mutation.log 2>&1
    result=$?
    set -e
    cat /tmp/c4-11a-mutation.log
    test "$result" -eq 101
    # Compilation failure is not observation. Require actual assertion failures.
    rg 'test result: FAILED' /tmp/c4-11a-mutation.log
    rg 'c4_11a_install_rebuilds_texture_type_layer_caches_and_expires_snapshots_7782.*FAILED' /tmp/c4-11a-mutation.log
    git apply "$patch"
    trap - EXIT
    cargo test -p ifc-lite-wasm c4_11a -- --nocapture
    ;;
  wasm)
    CI=true bash scripts/build-wasm.sh
    git diff --exit-code -- packages/wasm/pkg/ifc-lite.d.ts
    node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { initSync, IfcAPI } from './packages/wasm/pkg/ifc-lite.js';
import { runContentInstallContracts, runContentReplacementContracts } from './scripts/lib/wasm-content-install-contract.mjs';
import { runOwnedShardedPrepassContracts } from './scripts/lib/wasm-prepass-owned-columns-contract.mjs';
const { memory } = initSync(readFileSync('packages/wasm/pkg/ifc-lite_bg.wasm'));
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
runContentInstallContracts(IfcAPI, test);
runContentReplacementContracts(IfcAPI, test);
runOwnedShardedPrepassContracts(IfcAPI, test, memory);
console.log(JSON.stringify({ passed, skipped: 0 }));
JS
    ;;
  *) exit 2 ;;
esac
