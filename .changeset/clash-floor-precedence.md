---
"@ifc-lite/clash": patch
---

The precision floor applies to every branch that can label a result mesh-measured, not just the one that happened to check it.

`testPair` (`narrow.rs`'s `test_pair`) has three separate places that can build a `hard` result off a box-exact or AABB-estimate depth - the surface-crossing branch, the fully-enclosed-solid branch, and the coincide/shared-volume branch - and only the first checked the floor introduced by `clash-precision-floor.md` (#2594). A pair that was both fully enclosed (or coincident-footprint) AND below the floor for its coordinate magnitude still reported `hard`/`mesh` at the exact depth, unreclassified, because those two branches built their `NarrowResult` directly instead of going through the floor check. Reproduced with two 40 mm-overlap box slabs translated 1,000,000 units from the origin (floor ~0.238 m there, comfortably above the true 0.04 m depth): both branches returned `hard`/`mesh`/-0.04 in both kernels. Fixed by extracting the floor decision into one function each branch must route its candidate depth through (`depthClashResult` in `narrow.ts`, `depth_clash_result` in the new `rust/clash/src/depth.rs`) - so a fourth mesh-labelling branch added later inherits the precedence by construction rather than by remembering to copy it.
