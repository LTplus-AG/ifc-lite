---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
---

Add `bim.style`, colour that ends up in the exported IFC.

`bim.viewer.colorize` paints the current view. The colour is an overlay and is gone the moment the model is written out, so a script that wanted a coloured file had to hand-build the `IfcColourRgb → IfcSurfaceStyleShading → IfcSurfaceStyle → IfcStyledItem` chain itself and walk `IfcProductDefinitionShape → IfcShapeRepresentation → Items` to find something to attach it to. `StepExporter` already builds that chain internally for demeshed output; nothing exposed it.

`bim.style.apply(refs, color)` and `bim.style.applyAll(batches)` take `#rgb`, `#rrggbb`, or channels in 0..1, and return what was styled. The work lives in `applyStyleInStore` in `@ifc-lite/create`, beside the other in-store builders, and writes through the same `StoreEditor` overlay as `bim.spaces.generate`, so the entities are in the export with no extra step. Like `spaces`, the backend member is optional: local and headless contexts implement it, and a remote backend throws with a message that says why.

Three things the call site no longer has to get right:

**Mapped geometry.** An `IfcMappedItem` is followed through to the `IfcRepresentationMap` and the mapped representation's items are styled, so one style covers every occurrence of a type. On a real MEP model, 139 air terminals share 63 geometry items; styling per occurrence would write a second `IfcStyledItem` on geometry that already had one, which IFC does not allow.

**Geometry that already has a style.** IFC permits at most one `IfcStyledItem` per representation item. The existing one is tombstoned rather than joined by a second, or kept and the item skipped under `replaceExisting: false`. The detached `IfcSurfaceStyle` is deliberately left in the file: it can be shared with styled items the call never touched, and an unreferenced style definition is valid IFC.

**IFC2X3.** That schema has no `IfcStyleAssignmentSelect`, so `IfcStyledItem.Styles` there is a set of `IfcPresentationStyleAssignment`; the wrapper is written on 2X3 and skipped on IFC4 and later, which deprecated it.

`productsWithoutGeometry` counts a product only when its own walk reached nothing. Deciding it from the growth of the shared item set instead would report every occurrence after the first as geometry-less whenever a type's occurrences share one mapped representation — which is most of them, and was wrong in the first cut of this.

Verified on the export rather than on the overlay, against a fixture carrying direct geometry, two occurrences behind one representation map, a product with no representation, and geometry that already carries a style.
