---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Add `bim.style`, colour that ends up in the exported IFC.

`bim.viewer.colorize` paints the current view. The colour is an overlay and is gone the moment the model is written out, so a script that wanted a coloured file had to hand-build the `IfcColourRgb → IfcSurfaceStyleShading → IfcSurfaceStyle → IfcStyledItem` chain itself and walk `IfcProductDefinitionShape → IfcShapeRepresentation → Items` to find something to attach it to. `StepExporter` already builds that chain internally for demeshed output; nothing exposed it.

`bim.style.apply(refs, color)` and `bim.style.applyAll(batches)` take any hex form `bim.viewer.colorize` takes — they share its `hexToRgba` — or channels in 0..1. The one deliberate difference is the failure mode: `hexToRgba` degrades an unparseable string to black, which is right for a transient overlay and wrong for something written into the file, so a non-hex string throws instead of being baked in as black.

The work lives in `applyStylesInStore` in `@ifc-lite/create`, beside the other in-store builders, and writes through the same `StoreEditor` overlay as `bim.spaces.generate`. Both headless backends implement it; a backend without direct store access, including the browser viewer's, throws.

Four things the call site no longer has to get right:

**Mapped geometry.** An `IfcMappedItem` is followed through to the `IfcRepresentationMap` and the mapped representation's items are styled, so one style covers every occurrence of a type. On a real MEP model, 139 air terminals share 63 geometry items; styling per occurrence would write a second `IfcStyledItem` on geometry that already had one, which IFC does not allow.

**Geometry that already has a style, including geometry this session styled.** IFC permits at most one `IfcStyledItem` per representation item. The index of existing styles covers both the source file and the overlay: `StoreEditor.addEntity` does not insert into `store.entityIndex`, so a source-only check could not see the session's own writes and a second `apply` over the same products emitted two styled items on one solid — a schema-invalid file, from the very machinery meant to prevent it. That index is also built once per pass rather than per batch, which was 87 ms per batch on a 92k-styled-item model, about two thirds of a colour-by-class run.

**Entities created in the same session.** Reads fall back to the overlay, so `bim.store.addWall(...)` followed by `bim.style.apply` colours the new wall instead of reporting it as geometry-less and leaving an orphan `IfcSurfaceStyle` in the file.

**Schema differences.** `Representation` is resolved by attribute name rather than by a hardcoded index 6, because that slot is `RepresentationMaps` on `IfcTypeProduct` — a list, so a constant index turned a type object into a silent no-op. IFC2X3 gets the `IfcPresentationStyleAssignment` wrapper that IFC4 deprecated. Transparency is rounded, since `1 - 0.9` otherwise reaches the STEP text as `0.09999999999999998`.

A batch that styles nothing writes nothing: `surfaceStyleId` is `null` and no colour chain is authored. A caller colouring by IFC class hands in one batch per class, and most classes in a real model — types, ports, spatial structure — reach no geometry, so emitting the style up front left an orphan `IfcColourRgb` / `IfcSurfaceStyleShading` / `IfcSurfaceStyle` per such batch. Found by using the API for a colour-by-class pass: 16 styles in the file where 5 were referenced.

`productsWithoutGeometry` counts a product only when its own walk reached nothing. Deciding it from the growth of the shared item set instead would report every occurrence after the first as geometry-less whenever a type's occurrences share one mapped representation — which is most of them, and was wrong in the first cut of this.

`followMappedItems: false` styles the `IfcMappedItem` per occurrence instead. Following the representation map is right for colouring by IFC class and wrong for any other grouping — by system, storey or property value, shared geometry takes whichever colour ran last and drags unrelated occurrences with it.

`schema` names the schema the chain is built for, defaulting to the store's. The style shape is decided when the style is authored and the export schema is chosen later, so an IFC4 model exported as IFC2X3 otherwise emits `IfcStyledItem.Styles` pointing straight at an `IfcSurfaceStyle`, which that schema does not allow. Converting existing style records during a schema change is a separate job for `StepExporter` and is not attempted here.

An `#rrggbbaa` string's alpha pair is honoured. `hexToRgba` discards those digits and takes alpha from its own argument, which is right for the viewer; here they are the only way the string form can ask for transparency, and dropping them silently wrote an opaque style.

Verified on the export rather than on the overlay, against a fixture carrying direct geometry, two occurrences behind one representation map, a product with no representation, and geometry that already carries a style.
