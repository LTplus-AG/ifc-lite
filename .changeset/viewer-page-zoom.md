---
"@ifc-lite/viewer": patch
"@ifc-lite/viewer-embed": patch
---

The viewer and the embed no longer block page zoom: `maximum-scale=1` and `user-scalable=no` are gone from the viewport meta, so low-vision users can pinch-zoom the panels on a phone. A pinch on the 3D model still drives the camera, because the canvas keeps `touch-action: none` (#5843).
