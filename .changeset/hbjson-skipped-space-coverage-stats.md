---
'@ifc-lite/geometry': minor
---

HBJSON export could silently drop `IfcSpace` volumes with malformed footprints, holes, or non-extrusion bodies and still report success, with no way for a caller to tell. The Rust exporter already computed the coverage stats (`spaces` seen, `rooms` emitted, `skipped`) but they never crossed the wasm boundary — `GeometryProcessor.exportHbjson` / `IfcLiteBridge.exportHbjson` only ever returned the raw bytes.

Added `GeometryProcessor.exportHbjsonWithStats(buffer, name)` and `IfcLiteBridge.exportHbjsonWithStats(content, name)`, returning `{ content: Uint8Array; stats: HbjsonStats }` alongside the existing byte-only methods (unchanged, still supported). `HbjsonStats` (also exported) carries `spaces`, `rooms`, `skipped`, `apertures`, `doors`, `shades`, `constructions`, and `interiorAdjacencies`, mirroring the Rust `ifc_lite_export::HbjsonStats` contract.
