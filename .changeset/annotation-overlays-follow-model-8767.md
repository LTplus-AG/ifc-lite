---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

IfcAnnotation overlays now follow the model (#8767). In 3D, annotation lines, filled regions and labels are clipped by the section plane, any extra cutting planes and the clip box, the same way the model's geometry is. A label disappears whole once its anchor is cut away. Clipping is opt-in with a new `sectionClipped` flag, default `false`, so existing callers see no change: as an option on `Renderer.setLineOverlay(channel, vertices, { sectionClipped })` (new `LineOverlayOptions` type) and as a field on `SymbolicFillInput` and `SymbolicTextInput`. The grid and the other reference layers still draw whole. In the viewer, annotations also respect isolation: isolating elements, soloing a storey or filtering by class now hides annotations outside that set, the same as it does for meshes.
