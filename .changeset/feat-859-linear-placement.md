---
"@ifc-lite/wasm": minor
---

Render IFC4x3 `IfcLinearPlacement` so products placed at a station along
an `IfcAlignment` land on the alignment instead of at world origin
(issue #859).

The placement resolver previously dispatched only on `IfcLocalPlacement`
— every other placement type fell through to identity. The reporter's
`linear-placement-of-signal.ifc` (railway track with signals, signs and
referents authored via `IfcLinearPlacement`) showed the obvious symptom:
only one signal rendered, all stacked at world origin, instead of the
dozens authored at varying stations along the gradient curve.

This change:

- Recognises `IfcLinearPlacement` in the placement resolver and resolves
  it by walking `RelativePlacement (IfcAxis2PlacementLinear)` →
  `Location (IfcPointByDistanceExpression)` → sampling the `BasisCurve`
  at `DistanceAlong`, then composing the curve-aligned frame with the
  authored lateral / vertical / longitudinal offsets. Falls back to the
  optional `CartesianPosition (IfcAxis2Placement3D)` when sampling fails
  rather than collapsing to identity.
- Adds an `IfcGradientCurve` arm to `ProfileProcessor::get_curve_points`
  that delegates to the `BaseCurve` (attr 2). Without this every linear
  placement on a gradient curve errored out at the curve walker.
- Adds an `IfcCurveSegment` (IFC4x3) fallback inside the composite-curve
  walker: emit each segment's `Placement.Location` as a sparse polyline
  sample and let the new linear-distance sampler interpolate between
  segment starts. For the railway fixture's long line segments this is
  exact at segment boundaries and within a few metres elsewhere — already
  a vast improvement over "all at origin". Per-segment parent-curve
  evaluation is follow-up scope.

Out of scope (logged as follow-ups under #859):
- Full `IfcGradientCurve` vertical evaluation so signals snap to the
  authored z grade instead of inheriting the base curve's z.
- Per-segment `ParentCurve` sampling inside each `IfcCurveSegment` for
  sub-segment accuracy on clothoid / arc segments.

Regression coverage:

- `rust/geometry/tests/issue_859_linear_placement.rs` — drives the
  reporter's fixture. Asserts `Route Indicator_01` (#3020, station
  353.1 m) and `Route Indicator_02` (#3031, station 853.1 m) land in MGA
  projected territory (∼452 600 / 4 539 528 etc.) instead of world
  origin, with a measured separation within 10 m of the authored 500 m.
  Pre-fix both centroids collapsed to ≈ (0, 0, 0).

Fixture `tests/models/issues/859_linear_placement_of_signal.ifc`
(228 KB) added to the manifest.
