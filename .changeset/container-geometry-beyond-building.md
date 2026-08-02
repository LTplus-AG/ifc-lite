---
'@ifc-lite/wasm': patch
---

Render geometry attached to any representationless spatial container, not just `IfcBuilding` (#1910). #1969 exempted `IfcBuilding` class-wide, which covers terrain/DGM exports that hang an `IfcShellBasedSurfaceModel` off the building. A DGM attached to an `IfcBuildingStorey` — or to any other container still blocked by name — still rendered nothing.

The exception is instance-level rather than class-level: a spatial container is admitted **only when that specific instance's `Representation` attribute is non-null**. Containers normally carry a null representation, so every file that works today takes the byte-identical prior path; the gate only permits a job that the overwhelmingly common case never creates.

Applied at all three discovery paths, which is the part that had to be got right: the serial scanner, the sharded column classifier (`buildPrePassStreamingSharded` supplies precomputed class columns and never consults the serial branch), and `combined_pre_pass` behind `buildPrePassOnce`. Missing any one of them would have produced geometry that renders under some load paths and not others — and on the sharded path, behaviour varying with how many workers the browser spun up. `scan_shard_classified`'s class bytes stay byte-identical to the serial classification for every entity outside the exception, preserving the sharded-merge guarantee.

Geometry hashes are untouched: `geom_hash` is deliberately RTC-invariant and all 9 of its tests pass unchanged, so no determinism manifest moves.

No perf verdict is quoted deliberately. This adds one attribute-presence scan per spatial container — bounded by the number of containers in a file, typically single digits — which the perf suite cannot resolve against run-to-run noise. Mesh, vertex and triangle counts are unchanged on every fixture, since none of their containers carries a representation.
