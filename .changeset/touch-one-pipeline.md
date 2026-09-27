---
"@ifc-lite/viewer": patch
---

Touch: a finger is handled by the touch controls only. The mouse controls used to process touch-sourced pointer events as well, so a one-finger drag was orbited twice, and the Measure tool could not place a point by tap in any mode. Measure now works by tap: two taps measure a distance in Drag mode, and a tap places a point in the polyline, angle and radius modes (#5856).
