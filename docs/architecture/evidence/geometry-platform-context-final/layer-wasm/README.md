<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual WASM layer and provenance witnesses

Six actual public batch cases matched pinned baseline and final candidate:
three synthesized fixture invariants, each with lazy index construction and
explicit public worker-column configuration. This invokes the compiled browser
WASM under Node; it does not exercise the first-party loader or worker runtime.

The three-layer wall returns material IDs `[200, 201, 200]`. Its air-gap variant
returns `[200, undefined, 200]`, never material zero. The two-item unsliceable
control returns geometry item IDs `[40, 48]`. All meshes contain actual geometry;
geometry class alone is not used as evidence of slicing.

[Receipt](receipt.json) identifies the source freeze, both runtimes, exact explicit
configuration and all compared getter names. [Compressed actual records](records.json.gz)
preserve every MeshDataJs getter, all collection getters, RTC flag, prepass and
scanned index, with typed-array bytes and explicit option absence. No comparison
channel was excluded. These fixtures have no textures; equal empty texture/UV
fields do not qualify texture rendering.

[Fixture data](fixtures.json) preserves the synthesized source, derived from the
existing `mesh_id_provenance` invariants. [Scratch consumer source](consumer.mjs.txt)
is retained as evidence text; copy it to a `.mjs` file and invoke Node with absolute
binding, binary and output paths after restoring fixtures to its recorded `/tmp`
locations. This is a qualification harness, not a second production mesher.
Every owned WASM handle is released in `finally`.
