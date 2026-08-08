---
"@ifc-lite/renderer": minor
---

Give the encode region the same device-loss discrimination as the rest of the frame, and report a viewport that degrades without recovering.

`render()`'s outer catch already told a synchronous device loss (a `DOMException`) apart from host memory pressure on a live device (a `RangeError`). The frame body's own catch — covering encoder work, the render passes and `submit` — did not, so a device that died after `getCurrentTexture()` had succeeded degraded quietly forever: no latch, no `onDeviceLost`, and no re-requested frame. Both catches now run one shared policy.

Adds `Renderer.onPersistentRenderDegradation(listener)` and the exported `RenderDegradationInfo` type: fired once per renderer when frames have kept failing well past the transient-retry budget, so a wedged viewport can be surfaced to the user and to error tracking by the host. The renderer itself files no telemetry.
