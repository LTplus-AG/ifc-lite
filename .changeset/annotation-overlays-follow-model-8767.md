---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

IfcAnnotation overlays now follow the model (#8767). In 3D, annotation lines, filled regions and labels are clipped by the section plane, any extra cutting planes and the clip box, the same way the model's geometry is. A label disappears whole once its anchor is cut away. The `annotation` line channel is always clipped. Fills and labels opt in with the new `sectionClipped` flag on `SymbolicFillInput` and `SymbolicTextInput` (default `false`, so existing callers see no change). The grid and the other reference layers still draw whole. In the viewer, annotations also respect isolation: isolating elements, soloing a storey or filtering by class now hides annotations outside that set, the same as it does for meshes.
