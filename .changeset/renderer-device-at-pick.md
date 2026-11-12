---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

The viewer asks for its WebGPU device when a file is picked, instead of after the interface reset mounts the viewport. `prerequestRendererDevice()` starts the renderer's adapter and device request early; the next `WebGPUDevice.init()` adopts that device instead of requesting its own. A device lost or a request that failed before then is replaced by a fresh request, and a device no renderer claims within 15 s is destroyed. Nothing is requested at idle.
