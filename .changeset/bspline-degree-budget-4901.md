---
"@ifc-lite/wasm": patch
---

Bound `IfcBSplineCurveWithKnots` / `IfcBSplineSurfaceWithKnots` degree and control-point count so a file-supplied value that was previously unbounded can no longer hang the geometry kernel (#4901). The Cox-de Boor basis-function evaluation is also now memoized instead of naively recursive, which is exponential in the degree, so legitimate B-spline curves and surfaces tessellate identically but faster; a file that still exceeds the (generous) bound now fails loudly per-element instead of stalling the whole load.
