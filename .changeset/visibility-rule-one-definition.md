---
"@ifc-lite/renderer": patch
---

The hide/isolate rule now has one definition inside the renderer, not six.

`isEntityVisible` was introduced for the draw paths so the Cesium world view could reach the same verdict the viewport does. Picking and raycasting still restated the rule inline — `pick`, `pickRect`, the pick piece-scan, both raycast-engine loops and the scene's instanced raycast each spelled out "not hidden, and isolated if isolation is active" in their own words. They agreed, but nothing held them together: the world view's disagreement began exactly this way.

Behaviour is unchanged; this is the same predicate, called instead of copied. The point-cloud query keeps its own rule deliberately — it filters whole assets on `hiddenIds` only, because a point cloud has no per-element ids to isolate on.
