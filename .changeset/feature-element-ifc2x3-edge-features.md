---
'@ifc-lite/drawing-2d': patch
---

Fix `isFeatureElementType` (`packages/drawing-2d/src/feature-elements.ts`) missing IFC2X3's edge-feature family — `IfcEdgeFeature`, `IfcChamferEdgeFeature`, `IfcRoundedEdgeFeature` — an `IfcFeatureElement` subtraction operand, same as `IfcOpeningElement`.

The hand-maintained type set this function checks is complete for IFC4 and IFC4X3 but IFC2X3 defines this edge-feature family, which was never added. For an IFC2X3 model containing a chamfer or rounded edge feature, the mesh-silhouette fallback path (which consumes raw `MeshData` and can't rely on the Rust profile extractor's schema-derived `is_subtype_of` check) treated the feature as real structure and drew it into the 2D plan — the exact spurious-geometry outcome this module exists to prevent, with no error.

Also adds `feature-elements.schema-parity.test.ts`, mirroring the existing `ifc-type-hierarchy.test.ts` pattern: it re-derives every `IfcFeatureElement` descendant from `@ifc-lite/data`'s generated IFC2X3/IFC4/IFC4X3 entity tables (already a devDependency, used only at test time) and asserts `isFeatureElementType` agrees in both directions, so a future schema bump or hand-edit can't reopen this gap silently.

Follow-up not done here: making `FEATURE_ELEMENT_TYPES` itself schema-derived at runtime would require promoting `@ifc-lite/data` from a devDependency to a runtime dependency of `drawing-2d`, which it does not otherwise need.
