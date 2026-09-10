---
"@ifc-lite/geometry": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Fix OBJ export silently exporting the whole model when an active isolation filter matches zero elements — the OBJ twin of the GLB fix in #4364 (itself the #4328 scenario: filtering the hierarchy panel's Class tab to a type present only in a federated model's other member, then exporting "Visible Only").

`ObjOptions::isolated` (Rust, `rust/export/src/obj.rs`) and the wasm `exportObj` binding (`rust/wasm-bindings/src/api/export_obj.rs`) collapsed "no isolation filter" and "isolation active, zero matches" into the same empty value via `Vec::is_empty()`, so both read as "export everything". They now distinguish the two the same way `GltfOptions::isolated` does after #4364: `isolated: Option<Vec<u32>>` on the Rust side (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), `Uint32Array | undefined` on the TS side (`undefined` = no filter, an empty array = active but matching nothing) — `GeometryProcessor.exportObj` / `IfcLiteBridge.exportObj` in `packages/geometry/src`.

Same-PR follow-up, mirroring the one #4364 needed for GLB: `ifc-lite export --format obj` (`packages/cli/src/commands/export-rust-formats.ts`) and the MCP `export_obj` tool (`packages/mcp/src/tools/export.ts`) both used to pass an explicit empty `Uint32Array` to `exportObj` whenever no `--type`/`type` filter was requested — under the new convention that reads as "isolation active, matches nothing" and would have made every unfiltered OBJ export fail closed with a misleading "0 meshes" error. Both now pass `undefined` when their filter is inactive.

Also adds a zero-output guard to the CLI's OBJ export path, closing the asymmetry with GLB's `countGlbMeshes` defense-in-depth check: unlike `exportGlb`, the Rust OBJ exporter has no "no render geometry" error signal — it always returns a string, even a header-only one with zero vertices. `@ifc-lite/export` gains `countObjVertices` (`packages/export/src/obj.ts`), and `export-rust-formats.ts`'s OBJ branch now `fatal()`s when it comes back 0 rather than writing that small-but-non-zero-byte file as a reported success.

`packages/geometry/src/index.ts`'s two isolation-semantics doc comments (added for `exportObj`, already present for `exportGlb`-adjacent code) are folded into the existing exporter docblock rather than left as a second block, to stay under `check-module-size.mjs`'s ratchet once `main`'s current budget for this file applies — no information lost, just consolidated.
