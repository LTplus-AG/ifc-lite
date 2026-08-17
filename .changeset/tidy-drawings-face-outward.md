---
"@ifc-lite/drawing-2d": patch
---

Orient mesh normals by signed volume before silhouette extraction, so an inward-wound solid no longer loses its projected line work (#2682). The silhouette test is winding-sensitive: on an inward-wound mesh it picked the far side of the solid, which the projection band then dropped, producing a blank drawing with no error. A mesh and its reversed twin now yield identical line work.
