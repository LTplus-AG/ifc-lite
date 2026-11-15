---
"@ifc-lite/viewer": patch
---

A loaded Rhino `.3dm`'s layer row now hides and shows its sub-layers as Rhino does. Hiding a layer hides everything under it. Showing it brings back each sub-layer that is on and the objects in it, and leaves a sub-layer that is off itself, an object hidden on its own, and an object behind an off layer without a row, hidden (#10214).
