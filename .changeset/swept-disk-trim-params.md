---
"@ifc-lite/wasm": patch
---

Honor `IfcSweptDiskSolid.StartParam` / `EndParam` for `IfcCompositeCurve` and `IfcPolyline` directrices. Previously these were silently ignored, so a swept disk solid like `IFCSWEPTDISKSOLID(#dir, 0.0095, $, 0., 1.)` with a 3-segment composite-curve directrix swept the entire curve instead of just segment `[0,1]` — most visible in rebar models authored by Revit/Tekla, where bars rendered 3-5× their real length with end hooks unfolded into the bar geometry.

The dispatch now honors trim parameters for the two directrix types whose IFC parameterisation is unambiguous from the entity:

- `IfcCompositeCurve` (and subtypes via `is_subtype_of`): segment-index based, each segment contributes 1.0 to the parameter.
- `IfcPolyline`: point-index based, each segment between consecutive points contributes 1.0.

Boundary segments are truncated by linear interpolation along the sampled polyline (exact for piecewise-linear input). Out-of-range params clamp; inverted ranges (`StartParam ≥ EndParam`) produce empty geometry. Other directrix types (`IfcLine`, `IfcCircle`, `IfcTrimmedCurve`, `IfcBSplineCurve`) still ignore trim — their parameterisations are length / angle / knot-based and need separate handling — flagged as a known limitation.

Adds 11 unit tests in `profiles::tests` covering: full-range identity, exact-half boundaries, strict-interior comparisons, two-point partial trim, fractional multi-segment trim with dedup, out-of-range clamping, inverted ranges, `SameSense=F` reverse-then-trim semantics, and direct-polyline-directrix paths.
