---
"@ifc-lite/wasm": patch
---

Sample `IfcSweptDiskSolid` directrix arcs in full 3D. A directrix segment that is an `IfcTrimmedCurve` over an `IfcCircle`/`IfcEllipse` was sampled through the 2D conic path and lifted with `z = 0`, dropping the arc's out-of-plane component. Rebar bend arcs (Tekla `IfcReinforcingBar` bodies) live in the XZ plane, so the flattened arc landed in the wrong plane and twisted the swept tube — L-bars grew a spurious hook and U-bars crumpled (issue #1348). The arc is now sampled against the conic's real 3D placement (centre + X/Y axes), honouring parameter and cartesian trim bounds. Fixes #1348 and the geometry half of #1350.
