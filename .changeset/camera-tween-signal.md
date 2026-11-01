---
"@ifc-lite/renderer": minor
---

Add `Camera.isTweening()`: true from the moment a timed pose tween (preset view, frame, home) starts until `update()` has applied its final pose, independent of whether a frame has run since. The viewer exposes it as `cameraCallbacks.isCameraTweening` so hosts and tests can wait on the tween instead of guessing from pose reads.
