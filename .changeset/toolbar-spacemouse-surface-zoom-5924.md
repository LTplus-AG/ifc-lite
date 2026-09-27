---
"@ifc-lite/viewer": patch
---

The toolbar zoom-in and the SpaceMouse dolly now stop short of the surface at the centre of the viewport instead of passing through thin objects (#5924), as the wheel (#5393) and touch pinch (#5547) already do. They go through the same gated surface pick, so there is no raycast while a model is streaming, above the orbit-pivot census limit, or with a robust orbit anchor. Zoom-out is unchanged.
