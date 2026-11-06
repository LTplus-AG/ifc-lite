---
"@ifc-lite/viewer": patch
---

Measure Point stays "Live" when a selection change keeps the selected centreline's snap curves: Ctrl-adding a product with no swept disk, re-selecting the same product, or hiding an unrelated one no longer empties the snap curves while the overlay rebuilds. A product the selection drops, a hidden product, a model unload and a placement or georeference change still clear its curves before the next frame (#9086).
