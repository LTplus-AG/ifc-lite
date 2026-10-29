---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained products now publish their resolved appearance. Every published part carries `color`, plus `geometryItemId` when it comes from an authored geometry item (type-map and unbound parts carry none, as in exact) and `materialName` when authored, resolved through the exact engine's own colour resolver, and `IfcAppearance` leaves `obligationsUnmet` (with M4, surface normals and persistent faces discharged, fully proved products publish `final` with no unmet obligations). A binding that carries a texture or an indexed colour palette refuses `appearance_unsupported`. The retained viewer joins the authored metallic/roughness finish. The default exact engine and default wasm are unchanged.
