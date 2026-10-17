---
'@ifc-lite/wasm': patch
---

Refuse non-finite input in geometry (#7678). A STEP REAL too large for the double range (`1.E400`) used to decode to infinity and reach meshes as NaN or infinite vertices: an extrusion depth, a profile dimension, a direction, a placement or a point list could all emit a broken mesh. The decoder now refuses that record for geometry, so the element fails closed, while property and quantity readers keep the value as before. `splitMeshByZones` also drops a triangle whose index is past 2^32 / 3 instead of wrapping to a wrong vertex on wasm32.

A declared conversion-based length unit whose factor is not a positive finite number (`1.E400`, `0.`, a negative value or an unreadable one) is refused for geometry too: no element is meshed and no alignment, grid or symbol overlay is drawn at an invented metre scale. The pre-pass `meta` then carries `unitScale: NaN` and `unitRefused: true`; pass `unitScale` back into the batch calls unchanged, since every batch router refuses a non-finite or non-positive scale.
