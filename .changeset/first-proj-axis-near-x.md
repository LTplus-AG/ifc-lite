---
'@ifc-lite/data': patch
---

`firstProjAxis` now follows the schema's `IfcFirstProjAxis` for an Axis within 1e-6 of +X or -X (#7751). The renderer's projection cut moved from 1e-6 to a 1e-9 numeric noise floor, so an Axis such as `(1, 1e-7, 0)` with no `RefDirection` gets about `(0,-1,0)` instead of `(0,+1,0)`. An Axis of exactly +X still gets `(0,1,0)` and exactly -X still gets `(0,-1,0)`.
