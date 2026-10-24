---
"@ifc-lite/wasm": patch
---

The streaming pre-pass (`buildPrePassStreaming`, `buildPrePassStreamingSharded`, `buildPrePassStreamingShardedWithSourceFingerprint`) now honours `IFCSITE` in `disabled_types`, as the native pipeline does. A disabled site is no longer scheduled as a geometry job or counted in `totalJobs`. The first site's placement still feeds `buildingRotation`, so the model keeps its frame whether or not site geometry is shown.
