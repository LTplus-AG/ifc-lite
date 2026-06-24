---
"@ifc-lite/geometry": patch
---

Fix two void-cut over-cuts on walls with direction-less (e.g. FreeCAD/brep) openings (#1337):

- Two rectangular openings on perpendicular walls whose world AABBs cross at a building corner were merged into one phantom bounding box and punched a hole through both walls. The opening merge now fires only when the two boxes coincide on at least two axes (so `bbox(A,B) == A ∪ B`, no phantom volume), which still collapses the aligned/tiled openings the merge exists to optimize.
- A deep box opening (cutter deeper than the wall is thick) had its through-host penetration axis guessed as its thinnest AABB axis, which for such cutters is in-plane rather than through-wall. The cap-flush extension then ran along the wrong axis and latched onto a neighbouring void's reveal facet, growing the hole ~0.3 m on later-cut openings. The penetration axis is now inferred from the axis along which the opening pierces past the host, falling back to thinnest only for genuinely flush cutters.
