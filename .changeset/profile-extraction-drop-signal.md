---
'@ifc-lite/wasm': minor
---

`extractProfiles` silently dropped any element whose `IfcExtrudedAreaSolid` (direct or via `IfcMappedItem`) failed to extract, or whose mapped-item chain exceeded the extractor's depth limit — the only trace was a Rust `diag_debug!` call compiled out of the shipped wasm build (neither `debug_geometry` nor `observability` is enabled there), so a dropped wall or slab was simply missing from the generated 2D construction drawing with no signal at all. `ProfileCollection` now exposes `skippedExpressIds`, the express IDs of every element dropped during extraction, empty on a clean model.
