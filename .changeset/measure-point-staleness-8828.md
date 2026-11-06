---
"@ifc-lite/viewer": patch
---

Measure Point mode (#8828): "Live" now ends as soon as the camera moves, whether by orbit, pan, wheel, keyboard, SpaceMouse, fly, a view preset, a projection toggle or a viewpoint restore, so the readout never names a point that is no longer under the cursor. A hover frame that lands just after a click no longer flips "Last" back to "Live". After a model reposition, the placed point carries the same "Stale" badge as distances, polylines, angles and radii. In Russian, "Last" now reads "Последнее", which agrees with "Текущее".
