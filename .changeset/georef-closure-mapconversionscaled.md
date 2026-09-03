---
'@ifc-lite/export': patch
---

Fix `collectGeoreferencingEntities` missing IFC4X3's `IfcMapConversionScaled` when rescuing georeferencing into a `visibleOnly`/`subsetEntityIds` STEP export closure.

`entityIndex.byType` is keyed by the raw STEP type name, not resolved to a supertype, and the rescue only looked up `IFCMAPCONVERSION`. A model georeferenced via IFC4X3's concrete subtype `IfcMapConversionScaled` still silently lost its georeferencing on such an export — the exact bug this rescue exists to fix. Fixed by looking up both concrete spellings, matching the same fix already applied in `step-georeferencing.ts`, `subset-roots.ts`, and `on-demand-georeferencing.ts` (#3243).
