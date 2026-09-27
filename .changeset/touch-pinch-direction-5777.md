---
"@ifc-lite/viewer": patch
---

Touch pinch zoom now follows the mobile convention: spreading two fingers zooms in and pinching them together zooms out (#5777). It was the reverse, because the pinch fed `Camera.zoom` a positive delta (zoom out) when the fingers spread. A zoom-in pinch still stops short of the surface under the pinch (#5547).
