#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
set -euo pipefail

# Invoke at the repository root under the managed validation launcher. Inherit
# its Cargo target; never create a private unmanaged build tree. Build failures
# are fatal and missing runtimes/probes fail the Node test, never skip it.
export CARGO_UNSTABLE_BUILD_STD="std,panic_abort"
rustup run nightly-2025-11-15 wasm-pack build rust/diff-wasm \
  --target web \
  --out-dir ../../packages/wasm/pkg-diff-decode-test \
  --out-name ifc-lite-diff \
  --release \
  --features decode-leak-test
node --test rust/diff-wasm/tests/decode-leak.test.mjs
