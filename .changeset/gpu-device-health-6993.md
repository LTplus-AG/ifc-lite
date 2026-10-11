---
"@ifc-lite/renderer": patch
---

Under `?perfTrace=1`, count GPU devices created, non-teardown device losses and uncaptured errors (`gpu.devices`, `gpu.deviceLost`, `gpu.uncapturedErrors`), so benchmark samples that lost their device and re-uploaded the scene can be flagged. Tracing off, the device is untouched as before.
