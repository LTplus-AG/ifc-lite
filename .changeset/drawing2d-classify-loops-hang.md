---
'@ifc-lite/drawing-2d': patch
---

Fix an infinite loop in `PolygonBuilder.classifyLoops` that hung the viewer at ~95% load (issue #2364). The nearest-ancestor search introduced by #2331 tested containment with a single point, so two partially-overlapping loops could each "contain" the other's start vertex, making the parent pointers cyclic and the nesting-depth walk spin forever. Parents are now restricted to earlier (larger-or-equal-area) loops in the area-descending sort, which keeps the ancestor relation acyclic by construction.
