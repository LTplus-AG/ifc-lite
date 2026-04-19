---
"@ifc-lite/wasm": patch
---

Slice single-solid walls by `IfcMaterialLayerSetUsage` so each layer renders in its own material colour. Sub-millimetre layers fold into their thicker neighbour so the clipper never sees degenerate interfaces, and slicing bails cleanly when the representation isn't a single item with an identity Position (multi-item reps, MappedItems, or translated extrusions fall through to the unsliced path).
