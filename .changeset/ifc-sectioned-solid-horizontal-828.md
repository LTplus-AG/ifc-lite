---
"@ifc-lite/wasm": patch
---

`IfcSectionedSolidHorizontal` now renders (issue #828). The IFC4x1
infrastructure entity — used for road / bridge alignments with varying
cross-sections — previously errored with "Unsupported representation
type". The new `SectionedSolidHorizontalProcessor` lofts every pair of
consecutive cross-sections via `extrude_profile_lofted`, parameterised
by each station's `IfcDistanceExpression.DistanceAlong`. The directrix
is treated as a straight line along the body's local +Y axis for this
first pass — the lofting topology and arc-length parameterisation are
correct, but horizontal/vertical curve evaluation (`IfcAlignmentCurve`
arc / line / parabolic segments) is deferred to a follow-up.

Along the way two profile gaps in the same fixture are also closed:

- **`IfcAsymmetricIShapeProfileDef`** — six steel-girder profiles in
  `tests/models/issues/828_sectioned-solid.ifc` used this entity. Added
  a 12-point CCW builder that mirrors `process_i_shape` but takes
  independent top/bottom flange widths and thicknesses, with the
  IFC4-mandated fallback `TopFlangeThickness ← BottomFlangeThickness`
  when the optional attribute is `$`. Fillet radii and flange slopes are
  parsed but ignored — same posture as the symmetric I-shape — which is
  sufficient for the bridge fixture and matches what Tekla / Revit
  exports look like in practice.

- **`IfcMirroredProfileDef` with implicit operator.** The spec says
  this subtype writes `$` for the inherited `Operator` attribute and
  reflects the parent profile about its local Y-axis (`x → −x`) plus
  reverses contour winding to keep outer loops CCW. The previous code
  required Operator to resolve and errored "Derived profile Operator
  not found"; it now short-circuits on the subtype and applies the
  implicit mirror. `IfcDerivedProfileDef` with a null/missing operator
  is now treated as the identity transform rather than an error (some
  authoring tools emit this when the derived profile equals its parent).

Regression test asserts every one of the 16
`IfcSectionedSolidHorizontal` entities in the fixture now lofts to a
non-empty mesh (pre-fix: 9 ok / 7 errored), and pins the canonical
pier #69's sweep length to ~134 m as a guard against future axis-remap
regressions.
