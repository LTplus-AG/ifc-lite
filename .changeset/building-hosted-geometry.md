---
'@ifc-lite/wasm': patch
---

Render geometry attached directly to `IfcBuilding` (#1910). Terrain/DGM exports hang an `IfcShellBasedSurfaceModel` straight off the building rather than off a dedicated element. `is_non_geometric_spatial` blocked `IfcBuilding`, so `has_geometry_by_name` returned false, the building never became a geometry job, and the model loaded with correct metadata and hierarchy but rendered nothing at all.

The reported `(0,0,0)` RTC offset is a consequence, not the cause: with no job to sample, RTC detection had nothing to look at and fell through to the placement-bounds scan, which sees only the origin placements such files use. Once the building is sampled, the existing raw-vertex probe in `sample_element_translation` reads its first vertex and re-bases correctly — no change to RTC detection itself was needed.

`IfcBuilding` now joins `IfcSpace`, `IfcSite` and `IfcSpatialZone` in the exempt set, the same fix `IfcSpatialZone` got in #1075 once Revit Family/Dynamo exports were found emitting it with a body. The gate only *permits* meshing — a building with no representation still produces nothing, which is the overwhelmingly common case — so the cost is one abandoned job per building. `IfcBuildingStorey` and the `IfcFacility`/`IfcFacilityPart` families stay blocked; no exporter has been observed giving them a body.

Mesh output is unchanged on every model whose building carries no representation, which is every fixture in the perf suite.
