---
"@ifc-lite/wasm": patch
---

Fix `IfcSweptDiskSolid` (rebar/piping) meshing producing an all-NaN mesh when the directrix has a duplicate consecutive point — a plain authoring artefact, such as two composite-curve segments sharing an endpoint. The rotation-minimising frame's tangent computation now skips duplicate directrix samples when differencing (leading, interior, and trailing cases), instead of taking the norm of a zero-length vector.
