---
"@ifc-lite/geometry": patch
---

Re-enable content-dedup on the production geometry paths with a cheap structural hash — it's now a net speedup on steel-heavy models instead of the slowdown that forced it off.

Content-dedup (skip re-meshing structurally-identical representation items) was disabled in the previous release because its 128-bit structural key recursively decoded the *entire* item subtree — every face, loop, and point — costing more than the meshing it saved. `item_signature` now hashes `IfcFacetedBrep` (the dominant type in Tekla steel exports, where thousands of geometrically identical plates and bolts each get their own representation) through the same cached byte-level fast paths the mesher uses, with zero `decode_by_id` per point. On a ~50k-part steel model the brep hash dropped from ~8 s to ~2 s — below the ~5 s of meshing it skips — flipping dedup from a 0.9× loss to a 1.3× win, with byte-identical geometry (0 fingerprint mismatches over 50k elements).

Dedup is gated to the cheap (brep) types in `item_dedup_key`, so procedural-geometry models — the ones whose recursive hash cost more than it saved — skip the hash entirely and pay nothing. The separate `IfcMappedItem` instancing cache is unaffected.
