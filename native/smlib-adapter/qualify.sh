#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Invoke through ifc-fleet run, never inside a second reservation.
set -euo pipefail
mode=${1:-native}
consumers=${2:-}
if [[ $# -gt 2 || ( -n "$consumers" && "$consumers" != --rust-consumers ) ||
      ( -n "$consumers" && "$mode" != native ) ]]; then
  printf 'usage: qualify.sh [native [--rust-consumers]|wasm]\n' >&2
  exit 2
fi
revision=c9c5979f04cea8c38213004d4f04df0dcfb40d05
cache=${IFCLITE_SDK_CACHE:-/tmp/ifclite-public-sdk-c9c5979}
# Fleet supplies its lifecycle-managed target. Keep compiled SDK objects under
# that owner; the public source/tool cache is not a persistent build workspace.
if [[ -z "${IFCLITE_ADAPTER_BUILD:-}" ]]; then
  : "${CARGO_TARGET_DIR:?qualification requires the admitted fleet target or an explicitly owned IFCLITE_ADAPTER_BUILD}"
  [[ "$CARGO_TARGET_DIR" == /* ]] || { printf 'CARGO_TARGET_DIR must be absolute\n' >&2; exit 2; }
fi
sdk=${SMLIB_SOURCE:-$cache/usd-brep}
mkdir -p "$cache"
# Respect the original mode lock before touching shared setup artifacts.
exec 8>"$cache/$mode.lock"
flock -n 8 || { printf 'qualification cache already owned\n' >&2; exit 73; }
exec 9>"$cache/setup.lock"
flock -n 9 || { printf 'qualification setup already owned\n' >&2; exit 73; }
if [[ ! -d "$sdk" ]]; then
  mkdir -p "$sdk"
  git -C "$sdk" init
  git -C "$sdk" fetch --depth 1 https://github.com/NVIDIA-Omniverse/usd-brep.git "$revision"
  git -C "$sdk" checkout --detach FETCH_HEAD
fi
[[ $(git -C "$sdk" rev-parse HEAD) == "$revision" ]]
source_id=$(git rev-parse HEAD)
# CMake caches bind to one absolute source path. Fleet checkouts differ by
# commit; retain previous builds/evidence instead of reusing their cache.
checkout_key=$(printf '%s' "$(pwd -P)" | sha256sum | cut -c1-12)
build=${IFCLITE_ADAPTER_BUILD:-$CARGO_TARGET_DIR/ifclite-smlib/$mode-$source_id-$checkout_key}
# Lock the normalized physical build directory too: official overrides may
# intentionally share one path across modes or through symlink aliases.
mkdir -p "$build"
build=$(realpath -e -- "$build")
exec 7>"$build/.qualification.lock"
flock -n 7 || { printf 'qualification build already owned\n' >&2; exit 73; }
# These public tool wheels supply prerequisites without system package changes.
if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
  if [[ ! -x "$cache/tools/cmake/data/bin/cmake" || ! -x "$cache/tools/ninja-1.11.1.4.data/scripts/ninja" ]]; then
    python3 native/smlib-adapter/acquire-tools.py "$cache/tools"
  fi
  export PATH="$cache/tools/cmake/data/bin:$cache/tools/ninja-1.11.1.4.data/scripts:$PATH"
fi
# Setup is complete; the original mode lock stays held through CTest.
flock -u 9
printf 'qualification source=%s sdk=%s host=%s mode=%s\n' "$source_id" "$revision" "$(hostname)" "$mode"
if [[ "$mode" == wasm ]]; then
  if ! command -v emcmake >/dev/null; then
    emsdk=${EMSDK:-$cache/emsdk}
    if [[ ! -d "$emsdk" ]]; then
      git clone --depth 1 --branch 4.0.15 https://github.com/emscripten-core/emsdk.git "$emsdk"
    fi
    "$emsdk/emsdk" install 4.0.15
    "$emsdk/emsdk" activate 4.0.15
    source "$emsdk/emsdk_env.sh"
  fi
  emcc --version
  emcmake cmake -S native/smlib-adapter -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE="$sdk"
elif [[ "$mode" == native ]]; then
  cmake -S native/smlib-adapter -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE="$sdk"
else
  printf 'mode must be native or wasm\n' >&2; exit 2
fi
cmake --build "$build" --parallel 4
ctest --test-dir "$build" --output-on-failure
if [[ "$consumers" == --rust-consumers ]]; then
  # Use this build's actual worker, never a caller's stale executable or an
  # absent environment variable that makes SDK-gated Rust tests skip.
  export IFCLITE_SMLIB_WORKER="$build/ifclite_smlib_worker"
  [[ -x "$IFCLITE_SMLIB_WORKER" ]] || {
    printf 'qualified native worker is missing: %s\n' "$IFCLITE_SMLIB_WORKER" >&2
    exit 2
  }
  printf 'qualification Rust consumers source=%s worker=%s\n' "$source_id" "$IFCLITE_SMLIB_WORKER"
  cargo test -p ifc-lite-geometry-runtime -p ifc-lite-processing --all-targets --no-fail-fast -- --nocapture
fi
printf 'qualification build=%s\n' "$build"
