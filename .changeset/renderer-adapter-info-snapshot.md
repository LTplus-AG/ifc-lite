---
"@ifc-lite/renderer": minor
---

Add `Renderer.getAdapterInfo()` / `WebGPUDevice.getAdapterInfo()` and the exported `AdapterInfoSnapshot` type: a vendor/architecture identity snapshot copied out of `GPUAdapterInfo` during `init()`. The read is fully defensive (a runtime without `adapter.info`, or one whose getter throws, still initialises and reports `null` - a throwing getter is additionally logged as a console warning rather than swallowed), the strings are copies rather than the live `GPUAdapterInfo`, and the snapshot survives `destroy()` - so it is safe to read at device-loss time, which is what it exists for: enriching GPU device-loss telemetry (#2624).
