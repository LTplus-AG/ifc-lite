---
"@ifc-lite/geometry": patch
---

Fix void-cut over-cut where two rectangular openings on perpendicular walls were merged into one phantom box at a building corner. Openings without an extrusion direction (e.g. FreeCAD/brep exports) defaulted to "direction-compatible", so a window on one wall and a door on the adjacent wall — whose world AABBs cross at the corner — collapsed into their bounding box and punched a hole through both walls. The opening merge now only fires when the two boxes coincide on at least two axes (so `bbox(A,B) == A ∪ B` with no phantom volume), which still collapses the aligned/tiled openings the merge exists to optimize. (#1337)
