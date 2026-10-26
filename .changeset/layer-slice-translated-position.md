---
"@ifc-lite/wasm": patch
---

Walls and slabs with an `IfcMaterialLayerSetUsage` are now split into one mesh per layer when their Body extrusion's `Position` is translated. Before, any non-zero `Location` skipped layer slicing, and the whole element was drawn in the first layer's colour (#8168). The layer offset is measured in the element's own coordinate system, so a translated solid uses the same layer planes as before. Positions that rotate the solid are still not sliced, and their layer diagnostic is now `skip:not-single-unrotated-item`.
