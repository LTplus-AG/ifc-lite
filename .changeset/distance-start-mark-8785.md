---
"@ifc-lite/viewer": patch
---

A just-set Distance start draws as the start mark until the end moves away from it (#8785). Before, it showed a zero-length line and a live "0 mm" label, and on touch, which has no hover, that label stayed until the second tap. The unused legacy `pendingMeasurePoint`, `addMeasurePoint` and `completeMeasurement` store API is removed.
