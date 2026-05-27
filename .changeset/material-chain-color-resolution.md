---
"@ifc-lite/wasm": patch
---

Resolve element colours that are authored via the `IfcMaterial` chain
(orphan `IfcStyledItem` → `IfcStyledRepresentation` →
`IfcMaterialDefinitionRepresentation`).

Files like schependomlaan.ifc and the bulk of ArchiCAD / Revit IFC2x3
exports don't attach `IfcStyledItem` to the geometry items themselves —
they attach styles to the underlying `IfcMaterial`. The streaming prepass
(`buildPrePassStreaming`) already folds those resolved colours into
`geometry_styles` keyed by the element's own express ID, but
`resolve_element_color` previously only looked them up by traversing the
representation chain and never checked the element-keyed entries. The
data sat unused and every such element rendered as the per-type grey
default.

`resolve_element_color` now:

1. Walks the representation chain as before (direct `IfcStyledItem` on a
   geometry item — including `IfcMappedItem` recursion via
   `find_color_for_geometry` — wins by IFC precedence).
2. Falls back to `geometry_styles.get(&entity.id)` for the element-keyed
   material-chain colour the prepass already computed.

Verified on `tests/models/ara3d/duplex.ifc`: 371 of 486 meshes (76%) now
pick up authored material colours (22 distinct colours from the IFC's
materials palette) instead of falling through to default grey. Direct
`IfcStyledItem`-on-geometry-item still wins where present.

Adds five inline unit tests to `rust/wasm-bindings/src/api/styling.rs`
covering: empty styles → None, direct-only, material-only, both (direct
wins), unrelated → None.
