# Actual IFCX composition and USD consumer comparison

This lane supplements the native STEP scene collector. It invokes existing public
consumers; it adds no production loader, geometry implementation or viewer path.
The browser/federation entry remains `loadFile(file, target)`. No viewer store or
GPU presentation was exercised here.

`fixtures.json` records twelve inputs downloaded through the existing fixture
fetcher and verified against the committed manifest SHA-256 values. The seven
IFCX files actually declare `ifcx_alpha`; the four Annex E STEP files declare
`IFC4X3_ADD2`. The optional IFCZIP contains an IFC plus six JPEG assets. Their
bytes, dimensions and exact archive-member resolution are inventoried. The
manifest records no per-model upstream source or redistribution license; this
receipt supplies neither. The image-texture Annex E fixture references a missing
`texture.png` companion. Inventory is not successful image display.

## IFCX consumer

`importer.mjs` calls actual `parseIfcx`, `parseFederatedIfcx`, `addIfcxOverlay` and
composition APIs. It records every exposed table/buffer and the real property and
quantity getter results, strings, relationships, hierarchy, path identities,
composed attributes/child edges, meshes, point clouds and georeferencing presence.
Typed arrays retain element type and raw bytes; scalar floats retain their bits.
Only elapsed parse time and ephemeral layer identifiers are excluded; layer
provenance uses the actual supplied filenames. Full and incremental composition
must agree. FireRating must add a real property with value `R30`; the PBR overlay
must contribute real `gltf::material` opinions to a nonempty base scene.

The pinned base entry is copied from revision
`8acd0715a5ad266cd57808b9889f6549fbf93631`. Both entries use identical dependency
builds regenerated through root `pnpm build --filter=@ifc-lite/ifcx`; all named
importer/dependency source packages are unchanged against that revision. This is
an actual importer comparison, not a claim that this JavaScript consumer invokes
Rust geometry. Source/build provenance is in `provenance.json`.

`importer-receipt.json` records seven equal complete structured scenes: five
standalone samples and two nonempty overlays. Witnesses include 1,065 points in
five point-cloud chunks, actual mesh topology and property/quantity tables, and a
FireRating property increase from nine to ten. The PBR overlay composes two
material opinions but changes no emitted mesh colors. All samples emit zero UVs
and texture pixels. The bridge IFCX emits no georeferencing extension result.
Those absent channels remain explicit qualification gaps. Declared remote schema
imports are recorded; the current parser does not fetch/resolve them.

```sh
node --import tsx tools/smlib-evaluation/scene-comparison/ifcx/importer.mjs \
  packages/ifcx/src/index.ts . /tmp/ifclite-scene-ifcx-candidate
node --import tsx tools/smlib-evaluation/scene-comparison/ifcx/importer.mjs \
  /tmp/ifclite-scene-ifcx-base/packages/ifcx/src/index.ts . /tmp/ifclite-scene-ifcx-base-results
node tools/smlib-evaluation/scene-comparison/ifcx/compare.mjs \
  /tmp/ifclite-scene-ifcx-base-results /tmp/ifclite-scene-ifcx-candidate \
  tools/smlib-evaluation/scene-comparison/ifcx/importer-receipt.json
```

## Actual USD export and stage consumer

`usd-export.mjs` invokes public `IfcAPI.exportUsd` using separate pinned-base and
candidate WASM binaries. The API consumes STEP bytes; it is not an IFCX-to-USD
scene exporter. Base WASM was built in its independent pinned checkout using
`CI=1 pnpm build:wasm`; tracked source/lock/type files remained unchanged. Candidate
artifacts were read without rebuilding or replacement. Binary/bindings hashes
and exact source-model/output-byte hashes are retained in the provenance and
artifact manifests.

`usd-semantic.py` opens the actual stages with OpenUSD 0.26.8. It compares complete
prim/attribute/relationship metadata, typed values and time samples, material
bindings, references, authored state and world transforms. It validates topology,
requires real meshes and asserts Z-up/metres. It also exports/reopens each actual
root layer through OpenUSD and compares the same semantics. These are pairwise
comparisons and independent invariants, not new golden pins.

`usd-receipt.json` records seven equal stages and successful layer roundtrips.
Witnesses include material bindings, 63 mapped references and 64 nonidentity mapped
world transforms, three individual-color materials, and 88 nonidentity transforms
on the georeferenced case. Reference-based sharing is distinct from native USD
instances: the observed instance/prototype counts are zero. All seven stages have
zero UV primvars and zero texture shaders, including the textured STEP inputs.
Existing USD texture preservation is therefore unqualified; equal absence is not
texture success.

```sh
node tools/smlib-evaluation/scene-comparison/ifcx/usd-export.mjs \
  packages/wasm/pkg/ifc-lite.js packages/wasm/pkg/ifc-lite_bg.wasm . /tmp/ifclite-scene-usd-candidate
# Run the same command with the pinned checkout's bindings/binary for BASE.
/tmp/ifclite-smlib-venv/bin/python tools/smlib-evaluation/scene-comparison/ifcx/usd-semantic.py \
  /tmp/ifclite-scene-usd-base /tmp/ifclite-scene-usd-candidate /tmp/ifclite-scene-usd-semantic
```

The independent native collector owns STEP mesh UV/pixel/URL witnesses. These
consumer lanes do not prove retained-kernel activation, source precision recovery,
all-format scene equivalence, live viewer ingestion, complete material semantics,
remote dependency closure, or all-consumer/all-platform preservation.
