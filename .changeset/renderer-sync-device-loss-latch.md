---
"@ifc-lite/renderer": patch
---

Contain a synchronous GPU device loss inside `render()`.

Safari 26.5 reports device loss by throwing `InvalidStateError` from the next
GPU call rather than (or long before) resolving `device.lost`. The frame's
canvas-resize branch calls `RenderPipeline.resize()` outside the inner
try/catch, so that throw escaped `render()` entirely: the host's animation loop
never reached its tail `requestAnimationFrame`, and the viewport froze
permanently with an uncaught exception and no `onDeviceLost` notification.

`render()` now never throws. A frame that throws latches the same `deviceLost`
state the async `device.lost` promise would — later frames degrade to quiet
skips, `isDeviceLost()` reports true, and `onDeviceLost` listeners fire once
with `reason: 'render-exception'`.
