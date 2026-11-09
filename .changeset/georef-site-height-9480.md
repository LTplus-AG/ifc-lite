---
"@ifc-lite/geometry": minor
"@ifc-lite/cache": minor
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

A georeferenced model whose IfcSite placement repeats the map anchor in map units now gets its height corrected too, not just its horizontal position (#9480). The site of a Vectorworks 2026 Update 7 export sits at 14 mm instead of 14 m, which used to leave the model 14 m low in the World view. The WASM pre-pass now publishes the IfcSite's world origin as a new optional `CoordinateInfo.siteOrigin` (IFC Z-up metres, before any RTC shift), and `CoordinateHandler.setWasmMetadata` takes it as an optional fourth argument. When ifc-lite detects the unit slip, the slipped part of the site's Z is added to the height, so the model lands at its authored elevation. The Georeferencing panel says whether the height was corrected. The cache format moves to v27 to carry `siteOrigin`, and older caches are rebuilt on load.
