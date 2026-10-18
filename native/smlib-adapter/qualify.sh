#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Invoke through ifc-fleet run, never inside a second reservation.
set -euo pipefail
mode=${1:-native}
revision=c9c5979f04cea8c38213004d4f04df0dcfb40d05
cache=${IFCLITE_SDK_CACHE:-/tmp/ifclite-public-sdk-c9c5979}
sdk=${SMLIB_SOURCE:-$cache/usd-brep}
if [[ ! -d "$sdk" ]]; then
  mkdir -p "$sdk"
  git -C "$sdk" init
  git -C "$sdk" fetch --depth 1 https://github.com/NVIDIA-Omniverse/usd-brep.git "$revision"
  git -C "$sdk" checkout --detach FETCH_HEAD
fi
[[ $(git -C "$sdk" rev-parse HEAD) == "$revision" ]]
source_id=$(git rev-parse HEAD)
build=${IFCLITE_ADAPTER_BUILD:-$cache/build-$mode}
mkdir -p "$cache"
# These public tool wheels supply prerequisites without system package changes.
if ! command -v cmake >/dev/null || ! command -v ninja >/dev/null; then
  if [[ ! -x "$cache/tools/cmake/data/bin/cmake" || ! -x "$cache/tools/ninja/data/bin/ninja" ]]; then
    python3 native/smlib-adapter/acquire-tools.py "$cache/tools"
  fi
  export PATH="$cache/tools/cmake/data/bin:$cache/tools/ninja/data/bin:$PATH"
fi
# Guard only this qualification cache, within the already-admitted job.
exec 8>"$cache/$mode.lock"
flock -n 8 || { printf 'qualification cache already owned\n' >&2; exit 73; }
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
printf 'qualification build=%s\n' "$build"
