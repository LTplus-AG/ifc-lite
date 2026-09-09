---
"@ifc-lite/geometry": patch
"@ifc-lite/viewer": patch
---

Fix GLB export silently exporting the whole model when an active isolation filter matches zero elements (reachable through "Export Visible Only" after filtering the hierarchy panel's Class tab to a type present only in a federated model's other member — the #4328 scenario, for the GLB exporter specifically).

`GltfOptions::isolated` (Rust) and `GeometryProcessor.exportGlb`'s `isolated` parameter (TS, across the wasm boundary) collapsed "no isolation filter" and "isolation active, zero matches" into the same empty value, so both read as "export everything". They now distinguish the two the way `packages/export/src/reference-collector.ts` and `packages/renderer/src/entity-visibility.ts` already do: `isolated: Option<Vec<u32>>` on the Rust side (`None` = no filter, `Some(ids)` = an active allowlist, empty or not), `Uint32Array | undefined` on the TS side (`undefined` = no filter, an empty array = active but matching nothing). `GLBExportDialog.tsx`'s two assemblers (from-meshes and the from-bytes/wasm fast path) both preserve this distinction end to end instead of collapsing it back to a boolean.
