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

echo "📦 Running pnpm install --frozen-lockfile..."
pnpm install --frozen-lockfile
