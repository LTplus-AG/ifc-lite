---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Cesium ion compatibility export now supports alignment models: each reached `IfcLinearPlacement` is written as the equivalent `IfcLocalPlacement` (same ID and parent, its resolved curve or `CartesianPosition` frame), because Cesium ion ignores a transformed `PlacementRelTo` for linear placements. Map-unit normalization reads unit records written with spaces after commas (`IFCSIUNIT(*, .LENGTHUNIT., $, .METRE.)`). `GeometryRouter::resolve_linear_placement_local_strict` exposes the strict local frame. Linear placements without `PlacementRelTo` still refuse atomically.
