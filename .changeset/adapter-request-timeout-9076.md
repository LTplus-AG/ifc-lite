---
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
---

A WebGPU adapter request that never settles no longer hangs the viewer (#9076). Some broken drivers, remote sessions and GPU-less headless browsers leave `navigator.gpu.requestAdapter()` pending forever. `WebGPUDevice.init()` now rejects with "GPU adapter request timed out" after 10 s (`ADAPTER_REQUEST_TIMEOUT_MS`), instead of never settling. The viewer's WebGPU check reports the usual no-GPU guidance in that case, instead of an endless "Loading file 0%". Retry asks for an adapter again.
