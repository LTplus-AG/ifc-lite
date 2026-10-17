---
'@ifc-lite/data': minor
'@ifc-lite/create': patch
'@ifc-lite/export': patch
'@ifc-lite/cli': patch
'@ifc-lite/parser': patch
---

One `PlacementRelTo` chain walker for TypeScript. `@ifc-lite/data` now exports `walkPlacementChain` (iterative, visited set, no depth cap), pinned to the Rust resolver by shared vectors in `rust/geometry/tests/fixtures/placement_chain_vectors.json`. The placement walkers in `create` (storey chain, storey frame, element transform frames, host geometry frame), `export` (anonymised-export root finder, LOD0 world matrices), `cli` (`--storey` selection) and the viewer (compare world placement, storey elevation) now use it, so a legal chain longer than the old 64/128/256/10 000-link caps resolves instead of being dropped, and a cycle is refused everywhere. `extractPlacementElevation` promotes a 2D `Location` to z = 0 like the Rust reader.
