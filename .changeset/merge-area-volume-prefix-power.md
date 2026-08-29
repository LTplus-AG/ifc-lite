---
'@ifc-lite/export': patch
---

Fix `MergedExporter`'s unit normalization applying a prefixed SI area/volume unit's multiplier linearly instead of raised to the unit's dimension (a CENTI square metre is `(10⁻²)²`, not `10⁻²`). Reachable only when merging models under `unitReconciliation: 'normalize'` where a non-primary model declares an explicit prefixed `IFCSIUNIT` for `AREAUNIT`/`VOLUMEUNIT` (rare); every area/volume quantity from that model was silently rescaled by the wrong factor.
