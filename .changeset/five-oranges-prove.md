---
"@ifc-lite/create": major
"@ifc-lite/export": patch
---

Add standard roof-plane slab quantities and typed pitch properties on geometric slabs aggregated under the roof. Keep the roof area quantities and measure its geometry through the aggregate. Keep measurements coherent through edits, sharing and history.

Footprint roofs no longer place geometry on `IfcRoof.Representation`. Traverse their aggregated slab parts to measure the whole roof; `RoofBuildResult.shapeRepId` and `productShapeId` identify the first plane. Opening anchors resolved for a roof plane include its owning `roofId`, so a cut immediately withholds unmeasured net quantities.

Unequal roof pitches meet on shared mitred faces without a thickness step. Clipped plane quantities, perpendicular thickness, plumb eaves and per-edge styles are preserved through editing, copying and export/reopen.
