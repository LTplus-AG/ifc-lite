---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

Hovering and navigating a large model is smooth again with the hover pre-highlight on ([#6392](https://github.com/LTplus-AG/ifc-lite/issues/6392)). On a 127K-element model, hovering went from about 17-21 fps back to 54-60 fps, and orbit and pan from about 33-35 to 45-48 renders per second.

- `PickingManager` now decides that a pick is over the pick-mesh budget from counts alone. Before, every pick walked each visible entity's pieces (including colour-merged extraction) just to reach the same CPU-raycast verdict, and the default-on hover pre-highlight runs that pick up to 20 times a second. The GPU/CPU route of every pick is unchanged.
- The viewport no longer re-renders on every hover-pick result or every orbit/pan pointermove. It subscribes to the hovered entity instead of the whole `hoverState` (which carries the cursor position), and `clearHover()` no longer notifies subscribers when nothing is hovered.
