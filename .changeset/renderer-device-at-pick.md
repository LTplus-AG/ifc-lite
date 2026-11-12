---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

The viewer asks for its WebGPU device when a file is picked, instead of after the interface reset mounts the viewport. `prerequestRendererDevice()` starts the renderer's adapter and device request early and returns a promise that resolves once `requestDevice` is in flight (at most 50 ms); the viewer awaits it before the reset, because the device can only be requested after the adapter resolves on the main thread. The next `WebGPUDevice.init()` adopts that device instead of requesting its own. A device lost or a request that failed before then is replaced by a fresh request, and a device no renderer claims within 15 s is destroyed. Nothing is requested at idle.
