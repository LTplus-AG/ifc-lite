---
"@ifc-lite/viewer": patch
---

The symbolic overlay parse (annotations, grids) waits until a load in progress settles and the page is idle, instead of running between the model appearing and the viewer becoming interactive.
