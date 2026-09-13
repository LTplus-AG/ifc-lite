---
"@ifc-lite/renderer": minor
---

Add canonical evaluated-surface identity to exact raycast intersections. `Intersection` now reports the federation `modelIndex`, unambiguous `geometryItemId`, and `sourceTriangleIndex` when the rendered triangle carries valid appearance provenance; `appearanceSourceTriangle()` exposes the same strict mapping for renderer consumers. Exact scene raycasts also honor the renderer's active section plane and crop box.
