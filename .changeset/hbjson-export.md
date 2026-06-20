---
"@ifc-lite/cli": minor
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Add HBJSON (Honeybee / Ladybug Tools energy & daylight model) export.

`ifc-lite export <file.ifc> --format hbjson` and `GeometryProcessor.exportHbjson(buffer, name)`
produce a Honeybee-valid model: `IfcSpace` volumes become watertight, planar-faced Rooms
(Floor / RoofCeiling / Wall) ready to load via `Model.from_hbjson` and run in Ladybug Tools /
Pollination. Rooms are built analytically from extruded-area profiles (not the render mesh),
so they are watertight by construction. Backed by a new pure-Rust `ifc-lite-export` crate
(source of truth for CLI / SDK / wasm). Apertures, doors, shades and constructions follow.
