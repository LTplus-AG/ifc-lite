---
"@ifc-lite/viewer": patch
---

A geometry worker or engine file that fails to load because the app was updated while the tab was open now shows a persistent "A new version of the viewer is available — reload to continue" notice with a Reload button, instead of a generic load error (#5609). It appears when the one automatic reload has already been used in this tab or cannot run. The lazy-chunk error fallback uses the same stale-deployment check.
