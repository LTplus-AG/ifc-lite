---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's added storey can carry its `Elevation` (`NewObject::elevation`, or `NewObject::with_elevation`), written as given in the project's length unit. An elevation on anything but an `IfcBuildingStorey`, or one that is not finite, is refused.
