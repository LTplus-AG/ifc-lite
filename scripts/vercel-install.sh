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
# needs three things on PATH:
#
#   1. `clang++` with the wasm32-unknown-unknown target
#   2. `wasm-ld` (from lld)
#   3. libc++ headers at `<llvm-prefix>/include/c++/v1`
#
# Amazon Linux 2023 ships #1 and #2 in dnf (clang20 / lld20 packages) but
# NOT libc++ headers — they're an LLVM source artefact. We pull just the
# headers from the matching LLVM release tarball (~8 MB) and lay out a
# minimal cross-prefix the shim can find. The whole thing lives under
# Vercel's persistent build-cache mount so subsequent deploys skip the
# dnf install + header download entirely.
#
# Local dev: `brew install llvm lld` on macOS gives you everything in
# `/opt/homebrew/opt/llvm/bin` + `/opt/homebrew/opt/lld/bin`, which the
# shim's toolchain file auto-detects. On Debian/Ubuntu run
# `apt install clang-20 lld-20 libc++-20-dev`.
provision_wasm_cxx_toolchain() {
  if [ ! -x "$(command -v dnf 2>/dev/null)" ]; then
    return 0  # Non-Vercel host; assume the dev provisioned LLVM locally.
  fi

  local llvm_version="20.1.8"
  local cross_prefix="${WASM_CXX_PREFIX:-/vercel/cache/wasm-cxx}"
  local cross_bin="$cross_prefix/bin"
  local libcxx_include="$cross_prefix/include/c++/v1"

  if [ -f "$libcxx_include/iostream" ] && [ -x "$cross_bin/clang++" ]; then
    echo "📦 wasm-cxx toolchain restored from cache at $cross_prefix"
  else
    echo "📦 Provisioning wasm-cxx toolchain at $cross_prefix..."
    if ! command -v clang++-20 >/dev/null 2>&1 && ! command -v clang20 >/dev/null 2>&1; then
      dnf install -y -q clang20 lld20 cmake \
        || { echo "❌ Failed to install clang20/lld20/cmake via dnf"; return 1; }
    fi
    mkdir -p "$cross_bin"
    local clang_real lld_real ar_real
    clang_real="$(command -v clang++-20 || command -v clang++20 || command -v clang++)"
    # Each clang tool ships under one or both naming conventions on AL2023.
    lld_real="$(command -v wasm-ld-20 || command -v wasm-ld20 || command -v wasm-ld)"
    ar_real="$(command -v llvm-ar-20 || command -v llvm-ar20 || command -v llvm-ar || command -v ar)"
    ln -sf "$clang_real" "$cross_bin/clang++"
    ln -sf "${clang_real%++}" "$cross_bin/clang"
    ln -sf "$lld_real" "$cross_bin/wasm-ld"
    ln -sf "$ar_real" "$cross_bin/llvm-ar"

    mkdir -p "$libcxx_include"
    # --strip-components=2 drops `libcxx-N.N.N.src/include/`
    curl --proto '=https' --tlsv1.2 -sSL \
      "https://github.com/llvm/llvm-project/releases/download/llvmorg-$llvm_version/libcxx-$llvm_version.src.tar.xz" \
      | tar -xJ -C "$libcxx_include" --strip-components=2 \
        "libcxx-$llvm_version.src/include" \
      || { echo "❌ Failed to fetch libcxx-$llvm_version headers"; return 1; }
  fi

  export WASM_CXX_SHIM_LLVM_BIN_DIR="$cross_bin"
  export WASM_CXX_SHIM_LIBCXX_HEADERS="$libcxx_include"
  echo "   WASM_CXX_SHIM_LLVM_BIN_DIR=$WASM_CXX_SHIM_LLVM_BIN_DIR"
  echo "   WASM_CXX_SHIM_LIBCXX_HEADERS=$WASM_CXX_SHIM_LIBCXX_HEADERS"
}
provision_wasm_cxx_toolchain

echo "📦 Running pnpm install --frozen-lockfile..."
pnpm install --frozen-lockfile
