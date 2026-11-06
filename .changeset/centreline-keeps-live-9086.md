---
"@ifc-lite/viewer": patch
---

Measure Point stays "Live" when a selection change keeps the selected centreline's snap curves: Ctrl-adding a product with no swept disk, re-selecting the same product, hiding an unrelated product or clicking a product of another model no longer empties the snap curves, nor blinks the drawn centreline off, while the overlay rebuilds. A product the selection drops, a hidden or isolated-out product, a model unload or replacement, a new single-file store and a placement, georeference or highlight change still clear its line and curves before the next frame (#9086).
