---
"@ifc-lite/viewer": patch
---

Add a cycle guard to the spatial-hierarchy builder so a malformed
`IfcRelAggregates` edge that points back at an ancestor no longer trips
"RangeError: Maximum call stack size exceeded" before the viewer can
draw anything (issue #841).

`rebuildSpatialHierarchy::buildNode` recursed on every aggregated child
that was itself a spatial-structure type. Without a visited-set guard
the recursion looped indefinitely along the cycle. The within-node
descendant walk (used for `elementToStorey` propagation) already had a
cycle guard, but the top-level node-to-node recursion did not. The
fix shares a `visited` set across the whole `buildNode` recursion and
skips children that are already in flight, so first-visit wins and any
back-edge is silently dropped.

Regression coverage:

- `apps/viewer/src/utils/spatialHierarchy.test.ts` — new
  "terminates without stack overflow on cyclic spatial aggregation
  (issue #841)" test pins the guard with a Project → Site → Building →
  Storey graph whose storey aggregates back to the building.
- `rust/geometry/tests/issue_841_house_stack_overflow.rs` — smoke test
  that drives every renderable product in the reporter's House.ifc
  through `process_element`, confirming the Rust geometry pipeline
  itself doesn't panic (the JS recursion is what was failing).

Fixture `tests/models/issues/841_house_stack_overflow.ifc` (1.4 MB)
added to the manifest.
