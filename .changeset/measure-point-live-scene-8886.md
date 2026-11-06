---
'@ifc-lite/viewer': patch
'@ifc-lite/renderer': patch
---

Measure Point mode: "Live" now ends when a resting cursor's point is hidden, isolated away or cut by a newly drawn section or box, or when the canvas resizes without changing shape. A hover while the camera moves keeps its snap glyph. The renderer gains `getPickClipRevision()`, which changes only when the clip that picks mirror changes.
