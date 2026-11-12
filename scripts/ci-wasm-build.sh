#!/bin/bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# The WASM build the CI build cache stores (scripts/ci-wasm-cache.mjs). Every
# workflow that builds with the cache active runs exactly `bash
# scripts/ci-wasm-build.sh`, so the commands are this file, which is a key
# input (scripts/wasm-build-inputs.txt), and the build env is whatever the
# Plan step saw. `plan` turns the cache off for a run whose step adds `env:`,
# an inline assignment, or anything else (scripts/lib/ci-wasm-build-step.mjs).
set -euo pipefail

# Start from the checkout, not from a restored entry.
node scripts/ci-wasm-cache.mjs clean
# The decode-leak probe bundle first, so one entry holds every output and the
# engine build below (and turbo's rerun of it) leaves diff-wasm on its default
# features.
bash scripts/test-diff-decode-leaks.sh --build-only
bash scripts/build-wasm.sh
