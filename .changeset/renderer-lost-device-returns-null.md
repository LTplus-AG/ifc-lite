---
'@ifc-lite/renderer': patch
---

`Renderer.getGPUDevice()` now returns `null` once the GPU device has been lost,
instead of handing back a zombie device.

A lost device is not torn down: `WebGPUDevice.destroy()` is the only thing that
nulls the handle, and it is never called for an involuntary loss (Windows TDR,
GPU-process crash, driver reset). `isInitialized()` therefore stayed `true` and
the accessor kept returning the dead `GPUDevice`, so callers went on calling
`createBuffer()` on it — throwing a `RangeError`, and bypassing both
`render()`'s own `deviceLost` guard and every `onDeviceLost` listener.

Returning `null` routes into the `if (!device) return` check that call sites
already have, so a lost device degrades to "stop uploading" rather than an
uncaught throw. `isDeviceLost()` / `onDeviceLost()` are unchanged and remain the
recovery contract.

`finalizeStreaming()` is now rollback-safe. It detaches the old fragments and
batches before the replacement GPU buffers exist, so a `createBuffer` failure
part-way through the rebuild left the scene rendering a half-built — often
empty — array. Callers that contain the throw to keep the canvas alive would
therefore have turned a crash into a silently blank model. On failure the
previous drawables are restored (their GPU resources are still live, since the
destroy step never runs) and the error is rethrown for the caller to handle.
