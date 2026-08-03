---
'@ifc-lite/wasm': patch
---

Render geometry attached to any representationless spatial container, not just `IfcBuilding` (#1910). #1969 exempted `IfcBuilding` class-wide, which covers terrain/DGM exports that hang an `IfcShellBasedSurfaceModel` off the building. A DGM attached to an `IfcBuildingStorey` — or to any other container still blocked by name — still rendered nothing.

The exception is instance-level rather than class-level: a spatial container is admitted **only when that specific instance's `Representation` attribute is non-null**. Containers normally carry a null representation, so every file that works today takes the byte-identical prior path; the gate only permits a job that the overwhelmingly common case never creates.

Applied at all three discovery paths, which is the part that had to be got right: the serial scanner, the sharded column classifier (`buildPrePassStreamingSharded` supplies precomputed class columns and never consults the serial branch), and `combined_pre_pass` behind `buildPrePassOnce`. Missing any one of them would have produced geometry that renders under some load paths and not others — and on the sharded path, behaviour varying with how many workers the browser spun up. `scan_shard_classified`'s class bytes stay byte-identical to the serial classification for every entity outside the exception, preserving the sharded-merge guarantee.

Geometry hashes are untouched: `geom_hash` is deliberately RTC-invariant and all 9 of its tests pass unchanged, so no determinism manifest moves.

**This renders geometry that was previously skipped, so some models will draw more than before and take longer doing it.** That is the point of the change, but it is a behaviour change and not only a bug fix. The committed `AB22.ifc` infrastructure fixture is the worked example: it carries ten `IfcFacilityPart` entities — roadway, shoulders, roadside parts — and every one has a non-null `Representation`. All ten were silently skipped before and are now meshed. For identical input its clash count goes from 19 to 75, the 56 new pairs all involving the newly-meshed road surfaces, and the model takes roughly twice as long to process (measured ~180-205 ms before, ~380-450 ms after).

Files whose spatial containers carry no representation — the overwhelmingly common case — are unaffected and take the byte-identical prior path. But an infrastructure model that hangs geometry off `IfcFacilityPart`, which is exactly the shape this change exists to support, will render more and cost more.

The per-entity cost of the gate itself is one memoised name lookup plus, only for the handful of names that pass it, one attribute-presence scan; that part is not measurable against run-to-run noise. The cost above is the meshing of geometry that should always have been drawn.
