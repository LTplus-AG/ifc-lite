---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

Stop tripping "Maximum call stack size exceeded" / "too much recursion"
when loading House.ifc (issue #841). Two independent fixes:

**1. Iterative BSP CSG kernel — the actual House.ifc root cause.**

`rust/geometry/src/bsp_csg.rs` was a textbook recursive
build/clip/invert/all_polygons BSP. On House.ifc's 51 faceted Breps
(4120 IfcPolyLoops total) the partition tree degenerates into a near-
linked-list because so many wall and roof polygons are coplanar. The
recursive walk depth tracks the polygon count; native code rides on an
8 MB stack and never notices, but Firefox enforces a combined JS+WASM
call-depth limit around 10K frames and threw `InternalError: too much
recursion` mid-`parseMeshes`, hiding every wall, roof and floor in the
fixture.

Rewrite `BspNode::build`, `clip_polygons`, `clip_to`, `invert` and
`all_polygons` to use explicit `Vec`-based work stacks. Process-level
call depth is now O(1) regardless of tree shape. Also replace the
default recursive `Drop` for `Box<BspNode>` — destroying a depth-4096
tree the naive way overflowed on its own.

**2. Spatial-hierarchy cycle guard — defensive JS-side fix.**

`rebuildSpatialHierarchy::buildNode` recursed on every aggregated
child without a visited-set guard. A malformed `IfcRelAggregates`
back-edge would loop indefinitely. Not the cause of the reported
House.ifc failure (the WASM crash fires first) but a real
robustness gap for adversarial files.

Regression coverage:

- `rust/geometry/src/bsp_csg.rs::stack_safety_tests::deep_bsp_does_not_overflow`
  — feeds a depth-4096 degenerate quad stack through the entire
  build / walk / invert / clip / drop pipeline. Old recursive code
  would have OOM-stacked native too at this depth.
- `apps/viewer/src/utils/spatialHierarchy.test.ts` — "terminates
  without stack overflow on cyclic spatial aggregation (issue #841)"
  pins the JS guard with a Project → Site → Building → Storey graph
  whose storey aggregates back to the building.
- `rust/geometry/tests/issue_841_house_stack_overflow.rs` — drives
  every renderable product in the reporter's House.ifc through
  `process_element`, confirming the full IFC pipeline doesn't panic.

Fixture `tests/models/issues/841_house_stack_overflow.ifc` (1.4 MB)
added to the manifest.
