<!-- SPDX-License-Identifier: MPL-2.0 -->
# Additive rectangular transition assembly

Base: frozen ff87777ce8bad7b11276c3043cd3007e6bc628aa. Apply only this new
increment after the parent's exact ff877 integration; do not reapply earlier
checkpoint patches or overwrite their evidence. summary.json lists every changed
source/test/contract path with SHA256 before/after and unchanged local safeguards.
Evidence files do not self-hash.

The private fixed operation is described in PLANAR_TRANSITION_CONTRACT.md.
Four new production cpp files, two private headers, minimal Ledger/Scope/seal
hooks, existing sixth witness extension and one CMake library-source hunk.
No added/removed CTest, no protocol/capability advertisement, no copy/context/
plane/affine/mesh/qualifier/runtime/Rust/JS changes. Preserve all parent's newer
plane, oracle, fixture, browser harness, Arc, qualifier and runtime changes.
Local unchanged safeguard hashes describe this child base, not newer parent
qualification source. In a parent CMake with additional sources, add only the
four listed library sources; retain every parent target/source/test/flag.

Lightweight source checks only: C++17 -fsyntax-only -Wall -Wextra using actual
pinned c9c5979 headers; git diff --check; production module line-count and source
hash checks. SDK clean at c9c5979. No configure, compile-to-object, link, SDK
execution, CTest, native/WASM/Rust/Chrome, jobs or heavy submissions performed.
Every new actual witness is UNRUN and requires independent pinned review and
parent admitted native/WASM execution. No source-only numerical PASS claim.

Prior immutable evidence remains the original cf149f9a-2efe-4e77-8888-f856b36c3d09
log, SHA256 a47a5f405528672b7c156af3e32a09015fd2031d82cca6e2fafd37f490ae39d9.
Its lines54347–54384 show old sixth later-topology failure and seventh/eighth
Node/WASM PASS, before DNS provisioning stopped actual Rust/Chrome. It is not
this source's qualification, nor a complete browser/native qualification.

Freeze this bounded prerequisite for parent review/execution. Extra flags,
list changes, callbacks, unsupported graph classes or representation differences
remain explicit refusal/terminal isolation failures. No broader partition work
is included. Full shared intersection, checked classification/paired extraction,
interface ancestry and regularized-region proof remain unfinished.
