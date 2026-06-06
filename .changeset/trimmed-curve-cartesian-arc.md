---
"@ifc-lite/wasm": patch
---

Geometry: tessellate `IfcTrimmedCurve` arcs whose bounds are `IfcCartesianPoint`s ([#953](https://github.com/LTplus-AG/ifc-lite/issues/953)). When a profile's trimmed conic uses `MasterRepresentation = .CARTESIAN.` (the trims are points, not `IfcParameterValue`s), the bounds were dropped — the arc defaulted to a full circle that, with `SenseAgreement = .F.`, wrapped to a zero-length arc and collapsed the profile to flat triangles. The cartesian bounds are now inverted through the circle's placement into parametric angles, with `MasterRepresentation` selecting parameter-vs-cartesian and a fallback to whichever flavour is authored. Restores the semicircular wall profiles in `Roof-01_BCAD`.
