---
"@ifc-lite/wasm": patch
---

Rust only, in `ifc-lite-export`; nothing in the wasm package changes. An export plan's delete no longer prunes objects or types the plan did not delete: a port nested on a deleted host stays as a free product, and a type whose occurrences are all deleted stays declared. Relationships are repaired around them, and records only the deleted objects used (placements, geometry, property sets) are still pruned. Openings and projections still go with their host or their voids relationship, as IFC ties each to exactly one element. Deleting tens of thousands of objects that share large relationships now takes linear time instead of quadratic.
