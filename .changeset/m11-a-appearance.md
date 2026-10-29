---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained products now publish their resolved appearance. Every published part carries `color`, `geometryItemId` and (when authored) `materialName`, resolved through the exact engine's own colour resolver, and `IfcAppearance` leaves `obligationsUnmet` (a published product's `obligationsUnmet`, and the retained OBJ header, list `MaterialLayers, SurfaceNormals`). A binding that carries a texture or an indexed colour palette refuses `appearance_unsupported`. The retained viewer joins the authored metallic/roughness finish. The default exact engine and default wasm are unchanged.
