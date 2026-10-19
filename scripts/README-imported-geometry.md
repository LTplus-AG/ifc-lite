<!-- SPDX-License-Identifier: MPL-2.0 -->
# Imported geometry artifacts

Ordinary IFCX builds verify committed artifacts without Rust or translator setup.
For regeneration, install the root pinned Rust toolchain and wasm target, then run
`pnpm build:imported-geometry` from the root through fleet admission. In an isolated
worktree invoke the registered `env-exec.sh` using bash inside the fleet command.

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
directory. Source inputs, decoded WASM and all three generated code/declaration
files are hashed by `node scripts/build-imported-geometry.mjs --verify`.
Regenerate again when any recorded input changes, including Cargo.lock or headers.
The static target preserves synchronous use without WebAssembly or runtime code
compilation; root IFCX consumer tests exercise this on the actual emitted kernel.

Fixture-only provisioning/publication tests run via the existing `scripts/*.test.mjs`
workflow catch-all: `node --test scripts/imported-artifacts.test.mjs`.

After a root Turbo IFCX build, compare real numerical outputs against an exact
parent with `node --disallow-code-generation-from-strings scripts/compare-imported-geometry.mjs FULL_PARENT_COMMIT`.
It executes both static kernels through the unchanged production adapter, compares
all returned fields (including typed arrays, NaN, signed zero, bounds, indices,
normals, transforms and error behavior), and disables WebAssembly. Pass the
pre-migration baseline separately when qualifying a release; the immediate parent
comparison only attributes this layer. Root Turbo IFCX tests also exercise packet,
graph and scene behavior. The comparator also runs four real IFCX samples and
a federated overlay through both kernels, comparing meshes, point clouds,
hierarchy, path identity and georeferencing fields. Real sample build witnesses require the four IFC5 fixtures
listed in `packages/ifcx/scripts/verify-dist-hello-wall.mjs`; absent files are skips.

For an independently captured pre-migration consumer, run
`node scripts/compare-imported-capture.mjs BASE_CAPTURE NEW_OUTPUT` after preparing
its named, manifest-verified fixtures and workspace dependencies. This small-fixture
command reuses the original capture harness, validates its integrity manifest and
fixture hashes, executes current production source, and compares every captured
scene field and direct raw-bit case. It writes a fresh source/artifact-pinned
receipt. Historical summary labels are retained as original evidence; the new
receipt explicitly identifies the current Rust-generated numerical target.

Keep the two baselines distinct. A stale immediate-parent committed artifact can
reject current graph packets even while leaf numerical cases agree. Preserve that
failure; establish its source-regenerated baseline under fleet admission before
claiming parent attribution. An independent pre-migration match does not waive it.
