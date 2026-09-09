---
"@ifc-lite/create": minor
---

Add `addDrawingMarkupToStore` and its per-kind builders (`addMeasureMarkupToStore`, `addPolygonAreaMarkupToStore`, `addTextMarkupToStore`, `addCloudMarkupToStore`) — a pure translation from 2D drawing markup (measurements, polygon areas, text notes, revision clouds) into tagged `IfcAnnotation` entities via the additive `StoreEditor` overlay. Not wired into the viewer UI yet; see issue #4153 for the "save into model" direction this is the write half of.
