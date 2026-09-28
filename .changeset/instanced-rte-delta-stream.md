---
'@ifc-lite/renderer': patch
---

Orbiting, panning and zooming models with many GPU-instanced occurrences (MEP
fittings, fasteners, repeated furniture) no longer stalls GPU submission. The
camera-relative offset of each occurrence now lives in a separate per-template
buffer that is refreshed in one upload per template when the camera moves,
instead of one small upload per occurrence per pass; on a model with ~45K
instanced occurrences that took orbit from about 45 fps to vsync (#6393).
Shadows, the selection/hover outline and picking read the same buffer, and the
selection outline no longer draws instanced occurrences from a previous camera
position or outside the camera-relative range.
