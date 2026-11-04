---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Zoom and orbit on large or outlier models answer from the last frame's depth under the cursor (`Renderer.probeSurface`) where the CPU raycast is gated: wheel, pinch and toolbar zoom stop short of the surface instead of flying through, and the orbit pivots on what is under the pointer (#8769).
