---
"@ifc-lite/geometry": patch
---

Render `IfcSweptDiskSolid` elements whose directrix is an `IfcTrimmedCurve` (or bare `IfcLine`) — straight reinforcing bars, rods, and similar steel (issue #1164).

The 3D curve sampler had no `IfcLine` arm, so resolving a trimmed-line directrix returned "Unsupported curve type: IfcLine" and the swept-disk mesh collapsed to an empty mesh — the element silently failed to load. This is the common Tekla/IfcOpenShell encoding for a straight bar: `IfcSweptDiskSolid(IfcTrimmedCurve(IfcLine, 0., L, .PARAMETER.), r)`.

The sampler now handles `IfcLine` directly and a trimmed `IfcLine` in full 3D, honoring Trim1/Trim2 (parameter or cartesian bounds) and SenseAgreement, so the directrix samples to its true `[start, end]` segment instead of erroring. The swept-disk processor also applies a solid's own `StartParam`/`EndParam` to a bare `IfcLine` directrix. The 2D curve path no longer errors on `IfcLine` either.

The swept-disk mesh now also ships smooth per-vertex normals (computed in its small-coordinate directrix-local frame). It previously shipped empty normals, leaving consumers to recompute them from world-space f32 positions — which at a georef-scale placement (rebar at national-grid coordinates ~6 km from origin) cancel catastrophically into garbage normals, rendering the tube as a field of specular sparkles.
