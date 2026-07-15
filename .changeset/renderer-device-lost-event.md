---
'@ifc-lite/renderer': minor
---

Add `Renderer.onDeviceLost` so hosts can recover from a lost GPU device instead of a permanently blank canvas.

When the GPU device is lost for a non-intentional reason — e.g. a Windows TDR driver reset or VRAM exhaustion while rotating/re-opening a large model on a weak or integrated GPU — every pipeline and buffer created from it is dead and the viewport can never present again. Previously the renderer only logged a warning and kept trying to configure the lost device, leaving a permanently blank canvas until a full reload.

The renderer now:

- Distinguishes a real loss from an intentional teardown (`GPUDeviceLostInfo.reason === 'destroyed'`) and only reacts to the former.
- Exposes `Renderer.onDeviceLost(listener)` (returns an unsubscribe) and `Renderer.isDeviceLost()`. Hosts subscribe and typically respond by disposing the renderer and reloading the model. Camera and model state are CPU-side and survive the loss, so the reload restores the model at its current orientation.
- Makes `render()` a no-op after a loss instead of emitting a stream of GPU validation errors.
