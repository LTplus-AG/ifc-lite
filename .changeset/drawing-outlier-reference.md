---
"@ifc-lite/drawing-2d": patch
---

An elevation or section whose plane cuts little or nothing (for example one placed just inside the model bounds) no longer loses almost all of its projection lines. Artifact lines are now measured against the cut area together with the meshes' footprint on the drawing plane, instead of the cut area alone.
