---
'@ifc-lite/ifcx': minor
'@ifc-lite/parser': minor
'@ifc-lite/viewer': minor
---

`detectFormat` now returns `'3dm'` for a Rhino archive, read from the 24-byte header magic. A `.3dm` used to fall through to `'unknown'` and on into the IFC path. The viewer opens one as a model: dropping or picking a `.3dm` reads it in its own worker and loads its geometry, colours, entities and Attribute User Text through the same path every other format uses. Its store is labelled IFC4, the schema its classes belong to, and marked `sourceKind: 'tabular'`, so the STEP export, the merged export, appearance authoring and a room seed refuse it with a stated reason instead of writing an empty file.
