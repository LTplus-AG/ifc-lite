---
'@ifc-lite/tiles3d': minor
---

Add `@ifc-lite/tiles3d`, a headless OGC 3D Tiles reader. `readTilesetRegion` traverses a tileset for a WGS84 region and follows external tilesets. It culls `region`, `box` and `sphere` volumes through tile transform chains, and applies `ADD` or `REPLACE` refinement. Contents are b3dm or glb, with Draco through a lazily loaded `draco3d`. Each feature comes back as a float64 mesh in the tileset frame, with primitive groups, batch table attributes and tile provenance. Budgets truncate explicitly, failures are reported as issues, and partial results are kept. `ecefToGeodetic` and `geodeticToEcef` convert positions. A `readSwisstopoBuildings` preset covers swisstopo's buildings tileset.
