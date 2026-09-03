---
'@ifc-lite/wasm': minor
---

Added `IfcAPI.exportHbjsonWithStats(content, name)`, returning `{ content: Uint8Array; stats: HbjsonStats }` — the HBJSON bytes plus the export's coverage stats (`spaces`, `rooms`, `skipped`, `apertures`, `doors`, `shades`, `constructions`, `interiorAdjacencies`), computed in the same pass. Lets a caller tell whether a "successful" HBJSON export silently dropped `IfcSpace` volumes as degenerate. The existing byte-only `exportHbjson` is unchanged.
