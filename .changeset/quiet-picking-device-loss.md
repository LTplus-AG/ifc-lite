---
"@ifc-lite/renderer": patch
---

Return no selection when GPU device loss invalidates a completed pick readback, releasing pending buffers exactly once while preserving live-device errors.
