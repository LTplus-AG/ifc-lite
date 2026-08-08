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

`render()` now never throws, and what a throw MEANS depends on its type:

- a `DOMException` is the device reporting its own death. It latches the same
  `deviceLost` state the async `device.lost` promise would — later frames
  degrade to quiet skips, `isDeviceLost()` reports true, and `onDeviceLost`
  listeners fire once with `reason: 'render-exception'`.
- anything else costs only that frame. A `RangeError` from a buffer the host
  cannot allocate ("createBuffer failed, size (…) is too large … when
  mappedAtCreation == true") happens on a perfectly live device under memory
  pressure, and is reachable from capture frames
  (`restoreEvictedForCapture`). Latching there would kill the viewport for a
  failure whose blast radius should be one export, so instead the swap-chain
  config is invalidated, the failure is counted in `getDiagnostics()`, and the
  frame is re-requested so rendering actually resumes.

That re-request matters: hosts consume the dirty flag before calling `render()`,
so a failed frame has already spent its request and an idle viewer would
otherwise stay on the stale frame until the user next interacted. It is bounded
(three consecutive degraded frames) and reset by any frame that completes, so a
persistently failing path cannot self-perpetuate a throwing frame every tick.

`onDeviceLost` also replays to a listener that subscribes after the loss has
already latched, so a loss during `init()` still reaches the host.
