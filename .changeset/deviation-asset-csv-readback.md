---
"@ifc-lite/renderer": patch
---

Add export-only `readDeviationAssetStats()` after a completed scan deviation run. It returns signed-distance minimum, maximum and mean per scan asset, with model indices for federation attribution, and releases each GPU staging buffer after readback.
