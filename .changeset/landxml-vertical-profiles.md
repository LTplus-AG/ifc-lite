---
"@ifc-lite/create": minor
---

LandXML → IFC mapping v1.2: a written alignment's design profile (`ProfAlign`) is now exported as `IfcAlignmentVertical` with `IfcAlignmentVerticalSegment`s (`CONSTANTGRADIENT`, `PARABOLICARC`, `CIRCULARARC`; an `UnsymParaCurve` as two parabolic arcs) and an `IfcGradientCurve` over the horizontal composite curve, following IfcOpenShell's vertical segment mapping. Profiles that cannot be mapped exactly (sampled `ProfSurf`, unlinked, a second design profile, station equations, inconsistent curves, a profile running past its alignment) are refused by name with their reason. `AlignmentParams` gains an optional `Vertical` layout, `AlignmentResult` optional `verticalId` / `gradientCurveId`, and `LandXmlIfcCoverage` an optional `profiles` count.
