---
"@ifc-lite/viewer": patch
---

Touch pinch now zooms toward the surface under the pinch and stops short of it, instead of passing straight through thin objects such as pipes (#5547), matching the wheel since #5393. The viewer raycasts once per pinch, at the pinch midpoint, under the same gate as the wheel: no pick while streaming, on models above the orbit-pivot census limit, or with a robust orbit anchor. Zooming out and empty space keep the previous behaviour.
