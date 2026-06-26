---
"@ifc-lite/geometry": patch
---

Fix wall openings rendering filled when a single `IfcOpeningElement` carries a row of separate void bodies (#1367). The void router merged every body of such a high-vertex opening into one cutter and subtracted them in a single arrangement, which left diagonal "bridge" triangles spanning some of the holes. An opening is now split into one cutter per body when its bodies form 2 or more disjoint spatial clusters, so each window is cut on its own. Bodies that touch or overlap (one void split into adjacent parts, e.g. inner/outer wall-leaf halves of a window) still subtract merged, so the gable-wall watertightness path is unchanged.
