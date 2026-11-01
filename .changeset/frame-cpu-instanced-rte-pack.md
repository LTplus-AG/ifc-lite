---
"@ifc-lite/renderer": patch
---

Repacking GPU-instanced camera-relative deltas on a camera move no longer allocates per occurrence or re-validates the camera per occurrence; the uploaded high/low lanes are bit-identical.
