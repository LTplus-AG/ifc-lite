---
"@ifc-lite/viewer": patch
---

Compare now reads a placement with an Axis along -X and no RefDirection the same way the 3D view draws it (#5922). It used to fill the missing RefDirection with world Y, which turned the compared frame 180 degrees from what the viewer renders. It now uses the renderer's rule for every Axis-only placement: project world X, and where that gives nothing (Axis along ±X) use (0,0,1) × Axis.
