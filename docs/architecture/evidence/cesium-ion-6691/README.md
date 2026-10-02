# Zero-angle georeferencer roundoff: #6691

On 2026-10-02, the live [IFC Georeferencer](https://geo.buildingsmart.nl)
loaded its MiniBIM demo and downloaded IFC with every input unchanged. The
actual writer emitted direction `(1, 6.12323399573677e-17)` and physical scale
`1`. Our exact zero-ordinate check unnecessarily entered geometry preflight,
which refused an unreferenced `IfcConnectionSurfaceGeometry #132`. The source
contains 740 void relationships and 487 fill relationships.

The narrow fix recognizes an ordinate within `f64::EPSILON` while retaining
exact physical-scale and cosine checks. It returns no patches and preserves
the original ordinate, offsets, representations and relationships. It does not
snap the authored transform or expand genuine rotation/scale support.

[The recorded proof](./zero-angle-proof.json) includes the public writer source
SHA, base/fixed runtime hashes, complete exporter statistics and canonical plan
results. The real native and freshly built WASM planners return zero warnings
and zero patches for the default writer file. Its canonical adapted output is
byte-identical to plain export: 97,312 entities, no added or modified entities.
The base and fixed outputs are also byte-identical; the refusal is removed.
The live GeoBIM September release's exported DATA section independently matched
the canonical plain export, excluding headers.

The actual writer's 15-degree MiniBIM and 50-degree Archicad-house exports still
refuse unsupported normalization with no patches. Native and WASM tests cover
signed roundoff, machine-epsilon boundaries, non-unit direction vectors and
meaningful scale changes; these preserve the semantic guards.

A retained-owner IfcOpenShell 0.8.2 oracle sampled ten actual products: void
hosts, openings, filling doors, another wall and a slab. Original and exported
physical map-space vertices agree exactly, triangle indices and GUIDs are
preserved, and the original tiny direction agrees with identity at every
sampled map-space vertex. This bounded sample is not an all-product proof or
a claim about arbitrary large-coordinate files. The unchanged bytes establish
source preservation independently of that sample. No Hans file was available,
and this record does not diagnose it or claim new provider-upload acceptance.

To reproduce, download the unchanged MiniBIM demo from the live georeferencer
and verify its SHA against the record. Build with `scripts/build-wasm.sh` and
root `pnpm build`. Parse the same source using `IfcParser.parseColumnar`, then
compare `StepExporter.exportAsync` with `includeGeometry: true`,
`applyMutations: true`, `visibleOnly: false`, a fixed timestamp and source
schema: first omit normalization flags, then set both
`normalizeMapUnitsToMetres: true` and `normalizeMapGeometry: true`. Assert no
warnings or patches and identical exported bytes. The committed actual-WASM
regression exercises this contract with a typed IFC fixture and a retained
Name edit; run it through root `pnpm test --filter=@ifc-lite/export`.
The supported native revert-oracle command and verified behavioral failure
are recorded in the proof.
