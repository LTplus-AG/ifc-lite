---
"@ifc-lite/viewer": patch
---

The symbolic overlay parse (annotations, grids) of a model that is still loading waits until that model's load settles and the page is idle, instead of running between the model appearing and the viewer becoming interactive. Other models' overlays parse at once, and an overlay keeps its last parse on screen while a re-parse is pending.
