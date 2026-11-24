---
'@ifc-lite/renderer': patch
---

Colour-overridden surfaces now win coplanar depth ties deterministically. An override is no longer hidden by an identical uncoloured copy (for example a federated revision) depending on the camera angle or draw order. Scenes without colour overrides render exactly as before.
