---
'@ifc-lite/renderer': patch
---

Colour-overridden surfaces now win coplanar depth ties deterministically. An override is no longer hidden by an identical uncoloured copy (for example a federated revision), whatever the camera angle or draw order. Surfaces without a colour override keep their depth. In orthographic views the annotation overlay lift also clears the painted levels, so lines and text sit up to a quarter more nudge levels toward the camera.
