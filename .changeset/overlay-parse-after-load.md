---
"@ifc-lite/viewer": patch
---

The symbolic overlay parse (annotations, grids) of a model that is still loading waits until that model's load settles and the page is idle, instead of running between the model appearing and the viewer becoming interactive. A model's first overlay parse always waits for an idle period after its own load settled (also when its store is first seen after the load), and another model's load never holds it back; a re-parse of an already parsed model (an edit) runs at once, and an overlay keeps its last parse on screen while a re-parse is pending.
