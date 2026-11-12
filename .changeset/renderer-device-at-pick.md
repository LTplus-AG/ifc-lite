---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

The viewer asks for its WebGPU device when a file is picked, instead of after the interface reset mounts the viewport. `prerequestRendererDevice()` starts the renderer's adapter and device request early and returns a promise that resolves once `requestDevice` is in flight (at most 50 ms); the viewer awaits it before the reset, because the device can only be requested after the adapter resolves on the main thread. The next `WebGPUDevice.init()` adopts that device instead of requesting its own. An optional `setupGate` holds the claiming renderer's setup (at most 1 s) until the host opens it; the viewer opens it on a confirmed cache hit, at a cold load's first geometry pull, or when the load ends, so a cold load's file read and worker start are not displaced. A device lost or a request that failed before then is replaced by a fresh request, and a device no renderer claims within 15 s is destroyed. Nothing is requested at idle.
