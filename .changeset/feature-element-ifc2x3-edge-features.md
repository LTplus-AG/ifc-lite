---
'@ifc-lite/drawing-2d': patch
---

Recognise IFC2X3's edge-feature family in `isFeatureElementType` (`packages/drawing-2d/src/feature-elements.ts`): `IfcEdgeFeature` and its concrete leaves `IfcChamferEdgeFeature` / `IfcRoundedEdgeFeature`. All three descend from `IfcFeatureElementSubtraction`, so they are boolean subtraction operands like `IfcOpeningElement`, and the hand-maintained type set this predicate checks (complete for IFC4 and IFC4X3) never listed them.

No in-repo caller reached that gap, so this fixes no rendering symptom. `isFeatureElementType` is applied to `MeshData.ifcType`, and every mesh producer here labels a mesh with `IfcType::name()` (`rust/processing/src/element.rs:539`). The Rust schema enum has no edge-feature variant, so `legacy_aware_ifc_type` remaps both concrete leaves to `IfcFeatureElementSubtraction`, which the set already held, and the abstract `IfcEdgeFeature` is never instantiated in a file. What changes is the exported predicate itself, which callers outside this repo can hand any IFC type name.

Also adds `feature-elements.schema-parity.test.ts`, mirroring the existing `ifc-type-hierarchy.test.ts` pattern: it re-derives every `IfcFeatureElement` descendant from `@ifc-lite/data`'s generated IFC2X3/IFC4/IFC4X3 entity tables (already a devDependency, used only at test time) and asserts `isFeatureElementType` agrees in both directions, so a future schema bump or hand-edit cannot reopen this gap silently.

Follow-up not done here: making `FEATURE_ELEMENT_TYPES` itself schema-derived at runtime would require promoting `@ifc-lite/data` from a devDependency to a runtime dependency of `drawing-2d`, which it does not otherwise need.
