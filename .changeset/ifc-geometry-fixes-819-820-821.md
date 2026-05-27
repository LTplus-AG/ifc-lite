---
"@ifc-lite/wasm": patch
"@ifc-lite/parser": patch
---

Three IFC geometry fixes plus a Dutch / metric-export properties-panel fix.

- **#820 — `IfcTrimmedCurve` parameter values now respect `PLANEANGLEUNIT`.**
  `process_trimmed_conic` previously called `.to_radians()` unconditionally,
  silently shrinking a 240° arc to ~4° on files that declare
  `IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)` (e.g. the Renga-exported
  `RadianValuesOverPI.ifc` wall whose trim values are `5.7596`/`9.9484`
  radians). Added `extract_plane_angle_to_radians` to `ifc_lite_core::units`
  and a lazy lookup on `EntityDecoder` so the right scale (1.0 for RADIAN
  files, π/180 for DEGREE conversion-based units) is applied without
  per-call IFC scanning.

- **#821 — `IfcBooleanResult.DIFFERENCE` falls back to the un-cut host when
  the subtract emits an empty mesh from a non-empty host.** Revit IFC2x3
  exports (e.g. `TallBuilding.ifc`) sometimes author top-trim
  `IfcPolygonalBoundedHalfSpace` planes that land exactly on the wall's top
  with `AgreementFlag = .T.`, making the spec-strict half-space material
  region exactly cover the wall body — the strict subtract returns nothing
  and the wall vanishes. Production viewers (BIMVision, IfcOpenShell) revert
  to the host in this case; the processor now does the same and records the
  loss as `BoolFailureReason::DifferenceEmptiedHost` so it surfaces in CSG
  diagnostics rather than disappearing silently.

- **#819 — `IfcTriangulatedFaceSet` flat-shades by default.** Without
  per-vertex `Normals` the downstream normal accumulator was smooth-averaging
  face normals across every shared vertex, smearing crisp facet edges into
  muddy gradients on faceted geometry (visible on the
  `IFC4TessellationComplex.ifc` dome compared to BIMVision's flat-shaded
  render). The processor now duplicates vertices per-triangle and writes
  per-face normals, matching what `IfcPolygonalFaceSet` already does and
  the IfcOpenShell / web-ifc default.

- **Layer thickness display in the properties panel** (`MaterialCard`)
  showed "60.0 m" for a 60 mm prefab slab on `LENGTHUNIT=MILLI.METRE`
  files. `material-resolver` now multiplies the raw `IfcMaterialLayer.LayerThickness`
  by `store.lengthUnitScale` before storing it, so `formatThickness` sees a
  proper metres value and reports "60.0 mm".

Adds three regression tests pinned to fixtures under `tests/models/issues/`:
- `issue_819_triangulated_normals.rs`
- `issue_820_trimmed_curve_planeangleunit.rs`
- `issue_821_difference_emptied_host.rs`

Catalogue updated; fixtures will be uploaded to the `fixtures-v1` release.
