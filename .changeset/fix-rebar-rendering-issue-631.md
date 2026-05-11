---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
---

Fix `IfcReinforcingBar` stirrup rendering (issue #631, sample
`IfcReinforcingBar.ifc`).

`IfcSweptDiskSolid` directrixes that use `IfcIndexedPolyCurve` over
`IfcCartesianPointList3D` (typical for stirrups and other bent rebar that
lives outside the XY plane) used to fall back to a 2D parser that read x/y
from indices 0–1 and silently dropped the Z coordinate. The stirrup
collapsed onto z=0 and the resulting tube was a flat near-degenerate line.

The 3D curve dispatcher now has a native arm for `IfcIndexedPolyCurve` that
reads `IfcCartesianPointList2D` (z=0) or `IfcCartesianPointList3D` verbatim
and fits `IfcArcIndex` segments using a circumcircle in the plane of their
three control points. Straight schema conformance — no spec deviation.

The second sample on the issue (`Rebar2.ifc`) was already rendering its
directrix correctly under the existing segment-index trim path; no change
needed there.
