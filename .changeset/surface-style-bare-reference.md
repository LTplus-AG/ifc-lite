---
"@ifc-lite/wasm": patch
---

A bare entity reference written where a list is expected now colours the 3D mesh. An `IfcStyledItem` whose `Styles` is `#20` instead of `(#20)`, the same inside an IFC2X3 `IfcPresentationStyleAssignment`, and a bare `IfcSurfaceStyle.Styles` rendered in the default colour, while the 2D symbolic overlay already read a bare reference as a one-element list. Native processing and the browser WASM batch now share the single `DecodedEntity::get_refs` rule, including representation walks and the material chain's `IfcStyledRepresentation.Items`.
