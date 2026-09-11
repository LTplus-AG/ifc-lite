---
"@ifc-lite/geometry": major
"@ifc-lite/viewer": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/wasm": major
---

Fix GLB export silently exporting the whole model when an active isolation filter matches zero elements (reachable through "Export Visible Only" after filtering the hierarchy panel's Class tab to a type present only in a federated model's other member — the #4328 scenario, for the GLB exporter specifically).

`GltfOptions::isolated` (Rust) and `GeometryProcessor.exportGlb`'s `isolated` parameter (TS, across the wasm boundary) collapsed "no isolation filter" and "isolation active, zero matches" into the same empty value, so both read as "export everything". They now distinguish the two the way `packages/export/src/reference-collector.ts` and `packages/renderer/src/entity-visibility.ts` already do: `isolated: Option<Vec<u32>>` on the Rust side (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), `Uint32Array | undefined` on the TS side (`undefined` = no filter, an empty array = active but matching nothing). `GLBExportDialog.tsx`'s two assemblers (from-meshes and the from-bytes/wasm fast path) both preserve this distinction end to end instead of collapsing it back to a boolean.

Same-PR follow-up: `ifc-lite export --format glb`/`gltf` (`packages/cli/src/commands/export-rust-formats.ts`) and the MCP `export_glb` tool (`packages/mcp/src/tools/export.ts`) both pass an explicit empty `Uint32Array` to `exportGlb` whenever no `--type`/`type` filter is requested — under the new convention that reads as "isolation active, matches nothing" and made every unfiltered GLB export fail closed with a misleading "0 meshes" error. Both now pass `undefined` when their filter is inactive.
