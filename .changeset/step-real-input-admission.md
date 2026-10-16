---
'@ifc-lite/wasm': patch
---

Refuse non-finite input in geometry (#7678). A STEP REAL too large for the double range (`1.E400`) used to decode to infinity and reach meshes as NaN or infinite vertices: an extrusion depth, a profile dimension, a direction, a placement or a point list could all emit a broken mesh. The decoder now refuses that record for geometry, so the element fails closed, while property and quantity readers keep the value as before. `splitMeshByZones` also drops a triangle whose index is past 2^32 / 3 instead of wrapping to a wrong vertex on wasm32.
