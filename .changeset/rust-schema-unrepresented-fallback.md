---
"@ifc-lite/wasm": patch
---

`rust/export/src/schema_convert.rs` (the native/WASM STEP export path) now has a fallback for an IFC4-only entity type with no representation at all in an IFC2X3 target, mirroring the TypeScript exporter's `resolveUnrepresentedEntity`: a rooted type (e.g. `IfcStructuralCurveReaction`, `IfcTriangulatedFaceSet`) becomes an `IFCPROXY` placeholder instead of passing through unchanged under an invalid type name, and a non-rooted type (a representation item or resource type referenced positionally) now returns a clear error from `exportStep`/`exportStepJson` instead of silently shipping an invalid IFC2X3 file. `exportMerged`'s federated path is a documented, separate follow-up (mirrors the TS exporter's own scope boundary on that path).
