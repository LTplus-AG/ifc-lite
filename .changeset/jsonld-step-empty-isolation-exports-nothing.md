---
"@ifc-lite/geometry": patch
"@ifc-lite/cli": patch
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Fix JSON-LD and STEP export silently exporting the whole model when an active isolation filter matches zero entities — the last two formats still carrying the null-vs-empty collapse that #4364 removed for GLB and #4386 for OBJ.

Measured on `hello-wall.ifc` before the fix: a zero-match `jsonld` export was byte-identical to a whole-model one (1491 bytes, 9 `@graph` nodes both ways), as was `step` (79580 bytes, 1045 entities both ways), while a real `IfcWall` filter narrowed correctly to 1 node / 46 entities. The two calls were in fact indistinguishable, because the signature could not express the difference.

The `exportJsonld` / `exportStep` wasm bindings took a bare slice and mapped an empty one back to "no filter." Both bindings now use `Option<Vec<u32>>` (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), exposed as `Uint32Array | undefined` in `GeometryProcessor` and `IfcLiteBridge`. JSON-LD's stable Rust `JsonLdOptions::included: Vec<u32>` field keeps its existing shape and behavior for downstream callers; the additive `export_jsonld_with_filter` entry point carries the explicit optional filter used by wasm. An active-but-empty filter now yields an empty `@graph` and a header-only STEP file instead of the whole model. `ifc_lite_export::export_step_json` already took an `Option` and needed no change; only the binding above it did.

Mirroring the same-PR follow-up #4364 and #4386 each needed: `ifc-lite export --format jsonld|step` (`packages/cli/src/commands/export-rust-formats.ts`) used to pass an explicit empty `Uint32Array` whenever no `--type`/`--storey`/`--where`/`--limit` filter was requested, which under the new convention would read as "isolation active, matches nothing" and fail-close every unfiltered export. Both branches now pass `undefined` when their filter is inactive. There is no MCP or viewer caller to update: the MCP server exposes no JSON-LD or STEP export tool, and the viewer's STEP path is the TypeScript `StepExporter`, not this binding.

Also closes the guard asymmetry these two formats had with their siblings. `obj` and `gltf`/`glb` each carry a second, independent check on the produced artifact, so neutering the CLI's shared zero-match guard still leaves them failing closed; `jsonld` and `step` had that guard and nothing else. `@ifc-lite/export` gains `countJsonldNodes` and `countStepEntities` (`packages/export/src/zero-content.ts`) — both writers emit a valid, non-zero-byte document even when every entity is filtered out (JSON-LD keeps its `@context`, the STEP writer regenerates its ISO-10303-21 header), so a byte-length check cannot see an empty export and node/entity count is the content signal. The CLI's `jsonld` and `step` branches now `fatal()` when either comes back 0.

That second check is reachable on its own, not only behind the zero-match guard: `ifc-lite export --format jsonld --type IfcProject` matches an entity but produces no `@graph` node, and used to write that empty document as a reported success.
