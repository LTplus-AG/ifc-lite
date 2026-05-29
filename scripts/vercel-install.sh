#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Vercel `installCommand` entry point.
#
# After PR #657 we stopped committing the WASM bundles to git — see
# .gitignore and packages/wasm*/pkg/. Vercel must therefore bootstrap a
# Rust toolchain + wasm-pack before pnpm install so that `turbo build`
# can call `scripts/build-wasm.sh` and produce the bundles from source
# every deploy. The previous "commit-the-binary" model silently shipped
# stale bundles whenever a maintainer forgot to rebuild locally
# (issue #654).
#
# The script is idempotent: rustup and wasm-pack are no-ops if Vercel's
# build cache already restored them between deploys. Cold installs add
# ~30-60 s; warm cache adds essentially nothing.
set -euo pipefail

if ! command -v rustup >/dev/null 2>&1; then
  echo "📦 Installing rustup (minimal profile, no default toolchain)..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain none --profile minimal
fi

# rustup installs to ~/.cargo/bin by default. Add to PATH unconditionally
# — `command -v rustup` may succeed because the binary survived a cache
# restore, while `~/.cargo/env` (the helper sourcing file) did not. We
# saw exactly that on Vercel's iad1 runner in the first deploy of this
# branch. Sourcing the env file is best-effort and skipped when absent.
export PATH="$HOME/.cargo/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# rust-toolchain.toml at the repo root pins the channel + targets +
# components we need. `rustup show` is unreliable on Vercel's rustup
# build — it downloads components but doesn't fully register the
# toolchain, so `rustup run <channel>` from a later phase reports
# "toolchain not installed" even though `rustup show` claimed it was
# active (observed in fix/issue-654-catia-header-hash deploy logs on
# iad1: "installed toolchains: 1.92.0" listed by rustup show, but
# `rustup run nightly-2025-11-15` fails seconds later).
#
# Be explicit: parse the channel and call `rustup toolchain install`
# directly, which always produces a fully-registered installation.
CHANNEL=$(awk -F'"' '/^channel/ { print $2 }' rust-toolchain.toml)
if [ -z "$CHANNEL" ]; then
  echo "❌ Could not parse 'channel' from rust-toolchain.toml" >&2
  exit 1
fi
echo "📦 Installing Rust toolchain ${CHANNEL} with wasm32-unknown-unknown..."
rustup toolchain install "$CHANNEL" \
  --component rust-src \
  --target wasm32-unknown-unknown \
  --profile minimal

# Sanity check: any subsequent `rustup run "$CHANNEL"` must succeed.
# If this fails the build is doomed — fail loud here instead of in
# turbo's noisy output 30 lines later.
rustup run "$CHANNEL" rustc --version

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "📦 Installing wasm-pack (pre-built binary)..."
  # Use the upstream installer — pulls the latest pre-built binary in a
  # few seconds. `cargo install wasm-pack` would compile from source and
  # add ~3 min to the cold build.
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi

# ── wasm-cxx cross-toolchain (for the Manifold CSG kernel) ────────────────
#
# `ifc-lite-geometry`'s `manifold-csg-wasm-uu` feature compiles the Manifold
# C++ kernel into the wasm bundle via the `wasm-cxx-shim` helper. The shim
# needs a wasm-capable clang + wasm-ld + libc++ headers.
#
# Vercel's pinned Amazon Linux 2023 image (2023.2.20231011.0) only ships
# `clang15` in dnf, three versions below the shim's minimum. Rather than
# patch the shim, we lean on **emsdk** — Emscripten's bundled LLVM is a
# complete, wasm32-capable LLVM with libc++ headers pre-built. The shim's
# CMake toolchain file (`cmake/toolchain-wasm32.cmake`) auto-detects
# emsdk when the `EMSDK` env var is set, so the install boils down to
# clone + install + export.
#
# emsdk lives under `/vercel/cache/emsdk` so the ~340 MB binaries
# tarball is fetched at most once per project. Setting `WASM_CXX_PREFIX`
# overrides the cache dir for local repros.
#
# Local dev:
#   - macOS: `brew install llvm lld` works too — shim auto-detects
#     `/opt/homebrew/opt/llvm@N/bin`. emsdk install is equally fine.
#   - Debian/Ubuntu: `apt install clang-20 lld-20 libc++-20-dev`.
#   - Anywhere with python3 + git: `git clone emsdk.git && ./emsdk install latest`.
provision_wasm_cxx_toolchain() {
  if [ ! -x "$(command -v dnf 2>/dev/null)" ]; then
    return 0  # Non-Vercel host; assume the dev provisioned LLVM locally.
  fi

  # The wasm-cxx-shim drives the C++ build via cmake (3.25+ required).
  # AL2023's dnf-shipped cmake is 3.22.2 — too old. Download Kitware's
  # precompiled Linux x86_64 tarball into the cache instead. ~55 MB
  # one-time per project; survives between deploys via /vercel/cache.
  local cmake_version="${CMAKE_VERSION:-4.3.3}"
  local cmake_prefix="${WASM_CXX_PREFIX:-/vercel/cache/emsdk}/../cmake-$cmake_version"
  if [ ! -x "$cmake_prefix/bin/cmake" ]; then
    echo "📦 Provisioning cmake $cmake_version at $cmake_prefix..."
    mkdir -p "$cmake_prefix"
    curl --proto '=https' --tlsv1.2 -sSL \
      "https://github.com/Kitware/CMake/releases/download/v$cmake_version/cmake-$cmake_version-linux-x86_64.tar.gz" \
      | tar -xz -C "$cmake_prefix" --strip-components=1 \
      || { echo "❌ Failed to fetch cmake $cmake_version"; return 1; }
  else
    echo "📦 cmake $cmake_version restored from cache at $cmake_prefix"
  fi
  export PATH="$cmake_prefix/bin:$PATH"

  local emsdk_dir="${WASM_CXX_PREFIX:-/vercel/cache/emsdk}"
  # Synthetic prefix with the directory layout `wasm-cxx-shim`'s Rust
  # build.rs probe expects: clang++ + wasm-ld + llvm-ar in `bin/`, libc++
  # headers at `include/c++/v1/`. emsdk's native layout puts headers under
  # `upstream/emscripten/cache/sysroot/include/c++/v1/`, which the probe
  # won't find. Symlinks let both halves of the shim (Rust + CMake) point
  # at the same emsdk install.
  local cxx_prefix="$emsdk_dir/wasm-cxx-prefix"
  local cxx_bin="$cxx_prefix/bin"
  local cxx_include="$cxx_prefix/include/c++/v1"

  if [ -x "$emsdk_dir/upstream/bin/clang++" ]; then
    echo "📦 emsdk toolchain restored from cache at $emsdk_dir"
  else
    echo "📦 Provisioning emsdk at $emsdk_dir..."
    # python3 + git are pre-installed on Vercel; xz/tar come from
    # coreutils. Don't dnf-install anything — keeps the install hermetic
    # and avoids the package-version drift that bit us with clang20.
    if [ ! -d "$emsdk_dir/.git" ]; then
      git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$emsdk_dir" \
        || { echo "❌ Failed to clone emsdk into $emsdk_dir"; return 1; }
    fi
    (cd "$emsdk_dir" && ./emsdk install latest && ./emsdk activate latest) \
      || { echo "❌ emsdk install latest failed"; return 1; }
  fi

  # (Re)create the synthetic prefix every run. Symlinks are cheap, and
  # this lets us pick up emsdk SDK changes without invalidating the
  # whole cache directory.
  mkdir -p "$cxx_bin" "$cxx_prefix/include/c++"
  for tool in clang clang++ wasm-ld llvm-ar; do
    ln -sf "$emsdk_dir/upstream/bin/$tool" "$cxx_bin/$tool"
  done
  ln -sfn "$emsdk_dir/upstream/emscripten/cache/sysroot/include/c++/v1" "$cxx_include"

  export EMSDK="$emsdk_dir"
  export WASM_CXX_SHIM_LLVM_BIN_DIR="$cxx_bin"
  echo "   EMSDK=$EMSDK"
  echo "   WASM_CXX_SHIM_LLVM_BIN_DIR=$WASM_CXX_SHIM_LLVM_BIN_DIR"
}
provision_wasm_cxx_toolchain

echo "📦 Running pnpm install --frozen-lockfile..."
pnpm install --frozen-lockfile
