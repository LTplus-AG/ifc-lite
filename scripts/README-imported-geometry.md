<!-- SPDX-License-Identifier: MPL-2.0 -->
# Imported geometry artifacts

Ordinary IFCX builds run `--verify`, a Rust-free self-consistency check of the committed
artifacts against their recorded digests. It does not compare Rust sources, so workspace
version bumps and `Cargo.lock` updates never break a package build. Staleness is caught in
CI by `node scripts/build-imported-geometry.mjs --check`, which regenerates into a
temporary directory and fails if any committed artifact differs.
For regeneration, install the root pinned Rust toolchain and wasm target, then run
`pnpm build:imported-geometry` from the root through fleet admission. 
The generator provisions Linux x86_64 Binaryen 124 from the public Emscripten
4.0.15 SDK release `b412b6307e541b93dd93f01b61181e15c17302ec`, also selected by
the geometry-platform workflow's pinned emsdk checkout. It extracts only wasm2js,
verifies SHA256 `fb4bc51da37e8ea8917552fdcb6edf8e1b77e9081c220579b78c50c429b29f2a`,
and caches it under `$XDG_CACHE_HOME/ifc-lite/tools` (default `~/.cache`). This
requires network access, Node fetch and tar with xz support on first use. No SDK
activation, private directory or pre-existing temporary executable is needed.
`IFC_IMPORTED_WASM2JS` can select an offline executable with exactly those bytes;
other host architectures are rejected unless that exact executable can run there.
Provisioning and checksum verification precede compilation.

Translation and ABI/glue validation happen in a sibling staging directory. Failure
preserves previous generated artifacts; successful publication replaces the complete
directory. The provenance records only inputs that affect the bytes: the crate
(`rust/imported-geometry`), `rust-toolchain.toml`, `.cargo/config.toml`, the two generator
scripts and the root `[profile.release]` tables. Regenerate when any of those change.
The static target preserves synchronous use without WebAssembly or runtime code
compilation; root IFCX consumer tests exercise this on the actual emitted kernel.

Fixture-only provisioning/publication tests run via the existing `scripts/*.test.mjs`
workflow catch-all: `node --test scripts/imported-artifacts.test.mjs`.

Root Turbo IFCX tests exercise packet, graph and scene behavior on the emitted kernel.
Real sample build witnesses require the four IFC5 fixtures listed in
`packages/ifcx/scripts/verify-dist-hello-wall.mjs`; absent files are skips.
