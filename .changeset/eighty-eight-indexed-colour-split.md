---
"@ifc-lite/wasm": patch
---

Fix `IfcIndexedColourMap` per-triangle colours being ignored in the viewer (#858).

The browser geometry path (`processGeometryBatch`) only carried one dominant
colour per tessellated face set, so a face set whose `ColourIndex` assigns
different colours to different triangles rendered as a single solid colour. The
per-palette-group split (shared with the native processor) is now applied on the
WASM batch path too, so multi-coloured `IfcTriangulatedFaceSet` geometry renders
with all its authored colours again.
