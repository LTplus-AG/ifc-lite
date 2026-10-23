---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export`. An export plan's added extrusion can have voids (`Extrusion::voids`), written as an `IfcArbitraryProfileDefWithVoids`; each void must lie strictly inside the profile and apart from the others. `Representation::Extrusions` writes several extruded solids as items of one `Body` representation, for a region in disjoint parts. A profile without voids is written exactly as before.
