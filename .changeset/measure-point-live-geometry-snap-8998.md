---
'@ifc-lite/viewer': patch
'@ifc-lite/renderer': minor
---

Measure Point mode: "Live" now ends when the geometry under a resting cursor changes (an undo or redo of a modelling edit, an element moved by a command, geometry streaming in) and when Snap is turned on or off. Selection, hover highlight and idle frames keep it. The renderer gains `getPickGeometryRevision()`, which changes only when the geometry a pick can hit changes.
