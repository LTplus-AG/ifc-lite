---
"@ifc-lite/wasm": patch
---

`IfcSectionedSolidHorizontal` now renders with full directrix curve
evaluation (issue #828). The IFC4x1 infrastructure entity — used for
road / bridge / alignment models with varying cross-sections — was
previously erroring "Unsupported representation type". The new
`SectionedSolidHorizontalProcessor` plus the `crate::alignment`
evaluator sweep each profile along the actual `IfcAlignmentCurve`:

- **Horizontal alignment** — `IfcLineSegment2D`, `IfcCircularArcSegment2D`,
  and `IfcTransitionCurveSegment2D` (linear-curvature clothoid;
  Bloss / cubic-parabola / sine / cosine subtypes degrade to a
  clothoid with matching endpoint curvatures, which is geometrically
  continuous instead of a jump). Each segment's StartPoint /
  StartDirection / SegmentLength is taken as authoritative — the
  evaluator does not assume segments are pre-joined.
- **Vertical alignment** — `IfcAlignment2DVerSegLine`,
  `IfcAlignment2DVerSegParabolicArc`, and `IfcAlignment2DVerSegCircularArc`.
  Circular vertical curves use the parabolic approximation
  `z ≈ z₀ + g₀·s + ±s²/(2R)`, sub-mm-accurate for typical highway radii.
- **Plane-angle unit conversion** — `StartDirection` values are scaled
  via `EntityDecoder::plane_angle_to_radians()`, so files declaring
  `PLANEANGLEUNIT = .DEGREE.` (like the issue's fixture) get the right
  geometry.
- **Mesh construction** — each station gets a placement frame with
  `+X` perpendicular-right of travel and `+Z` along global up
  (FixedAxisVertical=true; cant/superelevation TODO). Side walls are
  one quad per profile edge per station pair with flat-shaded face
  normals; caps are earcut triangulations of the start and end
  profiles. A topology change (varying vertex count between adjacent
  cross-sections) closes the current sub-sweep with a cap and reopens
  a new one.
- **Falls back gracefully** when the directrix isn't an
  `IfcAlignmentCurve` (e.g. an arbitrary polyline) to a straight
  sweep along the body's local +Y axis.

Two profile types in the same fixture are also closed out:

- **`IfcAsymmetricIShapeProfileDef`** — six steel-girder profiles
  used this entity. Added a 12-point CCW builder with independent
  top/bottom flange widths and thicknesses; the IFC4 WR3 fallback
  (`TopFlangeThickness ← BottomFlangeThickness`) applies when the
  optional attribute is `$`. Fillet radii and flange slopes are
  parsed but ignored (same posture as the symmetric I-shape).
- **`IfcMirroredProfileDef` with implicit operator.** Per IFC4 §8.6.2.21
  this subtype writes `$` for `Operator` and reflects the parent
  about its local Y-axis. The previous code errored "Operator not
  found"; it now short-circuits with an explicit X-mirror plus
  contour-winding reversal. `IfcDerivedProfileDef` with a null
  operator is now treated as identity instead of failing.

Regression tests:
- `every_sectioned_solid_horizontal_in_fixture_lofts` — all 16
  sectioned solids in the fixture loft to non-empty meshes
  (pre-fix: 9/16).
- `sectioned_solid_horizontal_lofts_pier_69` — pier #69 has the
  expected curved bounds (~134 m principal span, several metres
  of lateral deflection that would be zero for a straight sweep,
  ~10+ m vertical from the parabolic sag at the far end).
- Three alignment-evaluator unit tests pin the line-segment, arc, and
  parabolic-vertical math against the fixture's authored numbers.
