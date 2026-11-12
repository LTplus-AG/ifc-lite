#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
set -euo pipefail

# Invoke at the repository root under the managed validation launcher. Inherit
# its Cargo target; never create a private unmanaged build tree. Build failures
# are fatal and missing runtimes/probes fail the Node test, never skip it.
#
#   (no argument)  build the probe bundle, then run the test
#   --build-only   build the probe bundle only (CI's WASM build cache builds it
#                  with the engine so one cache entry holds both)
#   --test-only    run the test against the bundle already on disk
phase="${1:-all}"
case "$phase" in
  all | --build-only | --test-only) ;;
  *)
    echo "usage: $0 [--build-only | --test-only]" >&2
    exit 2
    ;;
esac

if [ "$phase" != --test-only ]; then
  export CARGO_UNSTABLE_BUILD_STD="std,panic_abort"
  rustup run nightly-2025-11-15 wasm-pack build rust/diff-wasm \
    --target web \
    --out-dir ../../packages/wasm/pkg-diff-decode-test \
    --out-name ifc-lite-diff \
    --release \
    --features decode-leak-test
fi
if [ "$phase" != --build-only ]; then
  node --expose-gc --test rust/diff-wasm/tests/decode-leak.test.mjs
fi
