<!-- SPDX-License-Identifier: MPL-2.0 -->
# Imported geometry implementation assembly

Status: source implementation, **not a completed or qualified migration**. Final-source artifact regeneration and runtime qualification are blocked by the fleet disk admission guard. Do not activate/publish this source as a preservation-qualified replacement. The required package build verification deliberately rejects the historical generated artifact against the changed source.

## Source and integration

Exact requested parent: `86adb595c0c6429e1a0c423b962f9b153a1d2d0a`. `source-identity.json` pins the delivered local commit/tree and every changed file. No push, PR, issue claim, publication, foreign-job cancellation or manual validation checkout was performed. Every implementation child used app-managed worktree isolation. Machine admission refusals and all existing evidence were preserved.

This branch includes the authorized inherited private-source correction from parent `00a6923bab` (local cherry-pick `cccbc85887`). It fixes inherited E0616 build failures without exposing a decoder content getter. It also carries the original failed-run receipts from that parent commit; those are historical, not tests of this imported geometry source.

`incremental.patch` is relative to the exact requested parent and includes only the 65 owned import paths. The 11 inherited private-source fix/evidence paths are excluded because the integration parent already owns them. `files.json` pins both requested-parent and current integration-parent (`d625617742`) before hashes plus child-after hashes. Apply incremental hunks; do not overlay old full files, especially shared root manifests/API snapshots or the parent's Python lock/runtime filters.

The patch includes the source replacement, point-source codec seam, canonical viewer loading, build wiring, documentation, changesets and an honestly stale generated artifact with its original provenance. No generated WASM or declaration was hand-edited.

## Actual consumed ownership

Both `parseIfcx` and the shared initial/incremental federated finalizer call `extractImportedScene`. Existing public `extractGeometry` and `extractPointClouds` remain synchronous wrappers over the same owned graph, selecting mesh-only or point-only mode. Public `MeshData`, `PointCloudExtraction` and `IfcxParseResult` shapes remain unchanged.

`imported-graph.ts` snapshots only ordered source paths/edges, opens a Rust graph program and answers its reached source requests. It has no geometry traversal, eligibility filter, transform multiplication, topology conversion, point placement, normal engine or emitted-key set. Composition/property/quantity/hierarchy/string/relationship extraction remains in the existing parser.

`rust/imported-geometry/src/graph.rs` owns original-map seed candidates, path-based reachability, iterative ordered path-scoped traversal, mesh-then-point passes, inherited geometry context/type/visibility/color state, raw local matrix stacks, geometry eligibility and emitted-key suppression. Source requests are sequenced; stale kind/sequence replies are rejected without consuming the actual pending request. Opaque handles use a process-wide native namespace and an executor-instance WASM scope, are never reused, and closed in the host finally block.

Reached mesh/point payloads become source-independent `ImportedDefinition` values carrying store/revision/definition/occurrence identity. `scene::ImportedGeometryProgram` owns Ready issue, execution, identity/kind-matched completion and assembly. Numerical work has no STEP decoder, fabricated STEP entity ID, renderer callback or borrowed host view. The graph retains one Arc numeric source per definition/kind and one raw point metadata record, with separate occurrence identities/matrices. Source or codec metadata changes under one revision are terminal refusals. Pending output is moved rather than deeply cloned and is released after successful host presentation acknowledgment.

The host remains the format authority for appearance/image validation, once-per-image byte sharing, point codecs and exact JavaScript dedupe identity serialization. Rust decides when these source admissions occur, so hidden/type/duplicate geometry does not eagerly decode source or images. Source identity strings use injective JSON string serialization, preserving isolated UTF-16 surrogates without UTF-8 replacement collisions; this is identity transport, not another IFCX parser. Nullish matrix-cell defaults are resolved in f64 by the source adapter, with the untouched authored attribute retained separately.

Ready and execution values are sealed: only the issued immutable operation can produce an acceptable completion, even if another plan reuses its public identity. Native handle allocation uses a process-wide namespace while registries remain thread-local, so cross-thread handles cannot select another graph. These additional source-only changes have behavioral regression tests but no runtime qualification.

The internal `ImportedSourceDocument` retains original numeric definitions, ordered lineage/edge identities, owned nested composed-JSON snapshots and available layer provenance. It snapshots descriptors without invoking getters on uninterpreted values; one memo shares copied numeric/assets across references. Geometry buffers anchor the document lifetime through existing viewer conversion without adding public result fields. Mesh numeric definitions and decoded point definitions are shared across occurrences; output buffers remain distinct where the old format contract requires them. This retains parsed Number values, not original JSON number lexical spellings.

## Field and behavior preservation map

| Channel | Implementation/control |
| --- | --- |
| Layer strength, inheritance, tombstones, null masks, defaults | Existing composeIfcx/composeFederated and layer stack, unchanged semantic authority |
| Entities, properties, quantities, hierarchy, strings, relationships and getters | Existing parser extraction and return fields |
| pathToId/idToPath, optional ifcType, missing-code ID fallback | Existing path registry; Rust selects nearest entity node, host supplies its actual importer ID/class |
| Traversal, repeated instances, disconnected cycle components | Rust path-scoped walk; original-map candidates and path-keyed seeds preserve composed cycle stubs/order |
| Raw positions/topology/normals/local matrices | Admitted before Float32 conversion; original f64 and optional source fields retained separately |
| Display positions | Rust child*parent row-major staging, original per-local/per-composition f32 boundaries, then `(x,z,-y)` output |
| Mesh homogeneous denominator | Per-vertex validation and original divide/error text |
| Points denominator | Original first-point-only guard when length >=3 and reciprocal-multiply operation order |
| Explicit identity | Mesh canonical reset at every frame; point transforms retain explicit identity semantics |
| Face conversion and indices | Rust original fan order and Uint32 conversion; oversized wasm32 index arithmetic stays out of real vertices |
| Provided normals | Rust f32 inverse-transpose matrix, singular/nonfinite fallback and original normalization |
| Missing normals | Rust computes from displayed f32 positions, stages each accumulation addition to f32, then normalizes |
| Color, opacity, visibility, type exclusion | Raw opinions admitted at reached node; Rust controls eligibility/accumulation; existing format appearance resolver preserves exact public values/key serialization |
| Deduplication | Rust emitted set, supplied exact source/context/transform/appearance JS identity key; points intentionally do not inherit mesh suppression |
| UV/image/material opinions | Existing appearance extension/decoder and composed material opinions; UV staging in the shared Rust kernel, original pixels/encoded bytes/wraps shared |
| Point PCD/inline/base64 inputs | Shared existing codec logic exposes raw Float64 columns and source precision/encoding; Rust stages f32 before placement, preserving old display behavior |
| Point colors/count/bbox | Raw channels retained; Rust f32 staging and final presented bounds; existing output fields retained |
| Georeference and model pose | Existing extension validation and viewer placement/finalizer; no implicit new scale/up-axis interpretation |
| Warnings, source failures, overlay rollback | Existing parser authority and synchronous exception propagation; failed numerical work is terminal; finally closes Rust handle; overlay rollback remains around the same finalizer |
| Legitimate empty/symbolic/point-only scenes | Empty Rust graph/passes allowed; existing viewer allowEmptyGeometry rule and point-only support retained |
| USD and IFCX exports | Existing consumers remain; no new USD parser or alternate source loader. Current-source export roundtrips remain unrun |

These rows describe implemented paths and intended exact contracts; they are not runtime pass claims for the final source.

## Canonical viewer loading

Layered federation now passes ordered `ModelLoadOptions.ifcxSources` into `loadFile`. Loader sessions own source reads, stale/abort checks, parser execution, progress, finalization and publication. `parseIfcxViewerModel` selects existing single/layered parser APIs and uses one mesh/point/store conversion. Federation wrappers acquire inputs and invoke the canonical loader.

The canonical composed base owns the real geometry and ID range; overlay display entries share the composed store with zero ownership range. Original strongest-first model display and weakest-first layer stack order are preserved. Source identity includes ordered names plus actual source-byte SHA-256 values. Retained input buffers remain independently owned through overlay recomposition. Store-backed global ID resolution remains canonical. The previous layered point-cloud omission is explicitly corrected and covered by authored mounted tests, not described as a previously preserved behavior.

## Synchronous targets and packaging

One dependency-free Rust crate supplies native geometry, the full-WASM `processImportedGeometryPacket` entry and the small generated scalar kernel. Default synchronous extraction imports static ESM generated by pinned Binaryen wasm2js from that Rust WASM. It requires neither runtime WebAssembly compilation nor eval/Function; lazy factory initialization preserves no-setup public calls. There is no handwritten JavaScript numerical fallback.

`packages/ifcx` build runs generator `--verify`, TypeScript, `--copy`, and the existing dist smoke consumer. Root Turbo includes generator/Rust inputs; ordinary install/build/typecheck use committed generated outputs without a Rust/Binaryen prerequisite. Regeneration is the explicit root `pnpm build:imported-geometry` command under fleet admission. The generator pins compiler/lock/source/config/tool digests, scalar flags, translator arguments and artifact hashes. Tool provisioning is documented in `rust/imported-geometry/README.md`; the Linux wasm2js binary is pinned by exact emsdk revision/version and executable SHA-256.

Historical artifact actually generated from source `da65d2b974`: WASM 77,946 bytes, static JS 551,049 bytes, factory memory 1,179,648 bytes. Those are observed precursor artifact sizes, **not final-source size/performance evidence**. Subsequent source fixes alter graph OPEN layout and source ownership. `--verify` currently fails, correctly. Do not replace its provenance/source hashes to pretend it is current.

## Actual evidence and limits

- Exact-parent baseline: seven complete real IFCX scene records, eight raw-bit direct extractor cases, successful root build. Fixtures hash-verified against manifest. `base-consumer/evidence/qualification.json` records source/runtime/commands/skips; its immutable evidence is not overwritten.
- Raw point codec source `3eb50ecde5`: 357 tests passed, two external-fixture skips. This qualifies that codec seam only, not the new graph/runtime. Receipt `3d818ec0-1f31-49db-8e79-3faae2a2d52a`.
- Precursor source `da65d2b974`: actual scalar WASM/static generation and 22 Rust graph/packet/scene/math tests passed. Overall job failed clippy on four structural warnings; source-only fixes followed. Receipt `744ed59c-ff39-4707-ac96-807d8f618e9e`.
- A small precursor static factory ran with `WebAssembly=undefined` and Node `--disallow-code-generation-from-strings`, preserving observed f32 boundaries, negative zero and nonfinite values for opcode4. This is not full importer or browser geometry qualification.
- Viewer source plus inherited private-source fix: full WASM dependency build passed, root typecheck reached 125 tasks then Node's 2 GiB heap OOMed (exit134), with no TS diagnostic established. Higher-heap request later refused admission. Mounted viewer tests are authored, unrun for final source.
- Source metadata module-size gate passed. Generated-artifact verification intentionally failed on stale source identity. Other required final checks have not passed.

Latest actual fleet status: Pop admission allowed=false, guard78; PC reachable but drain restrictions remain; Mac disabled. Latest kernel request failed admission at 262.8GiB free against 266GiB required. Viewer higher-heap request failed admission at 208.2GiB free against 316GiB required. Neither executed its command. Do not retry them until an actual capacity change, bypass the guard, remove foreign resources, or resubmit unknown request `auto-5049ad4327104721832dd92ea474724d`.

## Work still required before completion

1. Restore eligible fleet capacity through authorized host administration; inspect existing requests/receipts rather than duplicating submitted work.
2. Regenerate **this final source** via the pinned generator; commit all outputs and pass required artifact verification. Regenerate the full WASM declarations only with the canonical `scripts/build-wasm.sh`; never hand-edit `pkg` bindings. Refresh API surface snapshot after real generated binding exists.
3. Run root Turbo typecheck/tests, cargo workspace tests and all-target warnings-denied clippy. Use adequate admitted Node heap for viewer, preserve meaningful skips. Run actual wasm boundary tests against a freshly built runtime.
4. Compare exact-parent versus final candidate full IFCX scene fields and the eight direct cases using existing actual comparator, plus new UV/image/georef/instance/negative/nonuniform/projective/large-coordinate/source-precision tests. Run fresh built-package/no-WebAssembly/noeval tests and real browser/worker imports.
5. Execute actual IFCX writer/import and USD export/stage reopen roundtrips; the predecessor USD receipts are not final-source evidence.
6. Measure paired end-to-end worker-pool performance, initialization/artifact/memory impact and output identity. Record the measured verdict in the performance ledger only after running it.
7. Resolve/qualify the wasm32 per-packet and live-heap capacity relative to previously supported JavaScript array sizes. The new binary packet envelope must not silently shrink supported models; this remains an explicit open compatibility gate, not an accepted support loss.

Current-source runtime equality, final generated types/API snapshot, all-platform packaging, complete native/browser/worker consumer coverage, worst-case capacity and performance remain unqualified. The broader goal has not been narrowed or marked complete.
