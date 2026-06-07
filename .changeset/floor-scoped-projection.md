---
"@ifc-lite/drawing-2d": minor
"@ifc-lite/wasm": patch
---

Scope construction projection to the current floor and exclude openings (#979 follow-up).

- **Current-floor scoping.** On a plan cut of a multi-storey model the projection
  bands now clamp to the storey the cut sits in, instead of projecting the whole
  model height — so a roof two levels up no longer draws on the ground-floor plan.
  New `@ifc-lite/drawing-2d` exports back this: `currentFloorBands` (pure band
  math) and `storeyFloorsFromMeshes` (per-storey floor levels from mesh-Y in the
  render frame, plus the `StoreyFloorMesh` type). The caller derives band depths
  from these; storey-less / single-storey / federated models fall back to the
  full-extent bands unchanged.
- **Opening exclusion.** `IfcOpeningElement` and the rest of the
  `IfcFeatureElement` family no longer participate in projection.
  `Drawing2DGenerator.generate` filters them from BOTH the profile and the
  mesh-silhouette paths via the new `isFeatureElementType` helper, and the Rust
  `extract_profiles` (`@ifc-lite/wasm`) skips `is_subtype_of(IfcFeatureElement)`
  at the source so opening void cross-sections never become projection profiles.
