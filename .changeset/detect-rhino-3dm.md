---
'@ifc-lite/ifcx': minor
'@ifc-lite/parser': minor
'@ifc-lite/viewer': minor
---

`detectFormat` now returns `'3dm'` for a Rhino archive, read from the 24-byte header magic. A `.3dm` used to fall through to `'unknown'` and on into the IFC path. The viewer opens one as a model: dropping or picking a `.3dm` reads it in its own worker and loads its geometry, colours, entities and Attribute User Text through the same path every other format uses.
