---
"@ifc-lite/wasm": patch
---

IFC4x3 `IfcSectionedSolidHorizontal` with `IfcAxis2PlacementLinear` positions now places the profile's +X to the left of travel, as the placement's local +Y, instead of mirroring it to the right. Asymmetric cross-sections such as bridge pavement courses (#7584) were shifted sideways off their deck, and their crossfall was reversed. On an `IfcGradientCurve` directrix, `DistanceAlong` is now read as horizontal station (the curve's parameter), not 3D length, and sectioned sweeps are wound outward.
