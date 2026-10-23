---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-export` and `ifc-lite-core`; nothing in the wasm package changes. An export plan's `Disposition::Add` now carries a typed `NewObject` and `plan::execute` builds it: class (checked against the source schema), caller-supplied GlobalId, placement, containment, aggregation and type, an extruded profile or triangle mesh body, colour, property and quantity sets, and an opening in a host. Each Add is checked in full before anything is written, and a refused Add writes nothing. `WriteReport::added` counts the objects built. In core, `guid::hash128` exposes the seed hash and `guid::encode` packs 128 bits into the 22-character IFC GlobalId form; `guid::deterministic` is their composition and its output is unchanged.
