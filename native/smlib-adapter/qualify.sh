#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Build the adapter against the pinned SDK, run CTest, then (optionally) the Rust
# worker-client tests against the freshly built worker.
#
#   native/smlib-adapter/qualify.sh [--rust-consumers]
#
# Environment:
#   SMLIB_SOURCE   existing usd-brep checkout at the pinned revision. If unset, the
#                  pinned revision is fetched into IFCLITE_SDK_CACHE (never vendored).
#   IFCLITE_SDK_CACHE   fetch location (default: ${TMPDIR:-/tmp}/ifclite-smlib-sdk)
#   IFCLITE_ADAPTER_BUILD   build directory (default: ${CARGO_TARGET_DIR:-target}/ifclite-smlib/native)
#   IFCLITE_BUILD_JOBS   parallel compile jobs (default 4)
set -euo pipefail
consumers=${1:-}
if [[ $# -gt 1 || ( -n "$consumers" && "$consumers" != --rust-consumers ) ]]; then
  printf 'usage: qualify.sh [--rust-consumers]\n' >&2
  exit 2
fi
revision=c9c5979f04cea8c38213004d4f04df0dcfb40d05
sdk=${SMLIB_SOURCE:-}
if [[ -z "$sdk" ]]; then
  cache=${IFCLITE_SDK_CACHE:-${TMPDIR:-/tmp}/ifclite-smlib-sdk}
  sdk=$cache/usd-brep
  if [[ ! -d "$sdk" ]]; then
    mkdir -p "$sdk"
    git -C "$sdk" init -q
    git -C "$sdk" fetch -q --depth 1 https://github.com/NVIDIA-Omniverse/usd-brep.git "$revision"
    git -C "$sdk" checkout -q --detach FETCH_HEAD
  fi
fi
[[ $(git -C "$sdk" rev-parse HEAD) == "$revision" ]] || {
  printf 'SDK checkout is not at the pinned revision %s\n' "$revision" >&2
  exit 2
}
build=${IFCLITE_ADAPTER_BUILD:-${CARGO_TARGET_DIR:-target}/ifclite-smlib/native}
printf 'qualification source=%s sdk=%s host=%s\n' "$(git rev-parse HEAD)" "$revision" "$(hostname)"
cmake -S native/smlib-adapter -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE="$sdk"
cmake --build "$build" --parallel "${IFCLITE_BUILD_JOBS:-4}"
ctest_status=0
ctest --test-dir "$build" --output-on-failure || ctest_status=$?
consumer_status=0
if [[ "$consumers" == --rust-consumers ]]; then
  export IFCLITE_SMLIB_WORKER
  IFCLITE_SMLIB_WORKER=$(cd "$build" && pwd -P)/ifclite_smlib_worker
  [[ -x "$IFCLITE_SMLIB_WORKER" ]] || {
    printf 'built native worker is missing: %s\n' "$IFCLITE_SMLIB_WORKER" >&2
    exit 2
  }
  # CTest and Rust workers have separate process isolation: gather both verdicts.
  cargo test -p ifc-lite-geometry-runtime --all-targets --no-fail-fast -- --nocapture || consumer_status=$?
  printf 'qualification_ctest_exit=%s rust_consumer_exit=%s worker=%s\n' \
    "$ctest_status" "$consumer_status" "$IFCLITE_SMLIB_WORKER"
fi
if [[ "$ctest_status" -ne 0 ]]; then exit "$ctest_status"; fi
exit "$consumer_status"
