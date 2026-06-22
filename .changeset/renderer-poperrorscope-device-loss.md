---
"@ifc-lite/renderer": patch
---

Stop a lost-device `popErrorScope` rejection from surfacing as an unhandled `DOMException`.

During the first few frames the renderer wraps the render pass in `pushErrorScope('validation')` and reads it back with `device.popErrorScope()`. That promise rejects (`OperationError: Instance dropped in popErrorScope`) when the GPU device is lost while the scope is still pending — something seen in the wild on Windows/Edge when the adapter resets. The `.then()` had no rejection handler, so the rejection escaped the surrounding synchronous `try/catch` and became an unhandled rejection reported as a top-level error. It is now caught and treated like any other device loss: the context is invalidated so it reconfigures on the next frame, with a throttled warning instead of a crash.
