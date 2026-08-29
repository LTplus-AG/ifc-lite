---
'@ifc-lite/data': patch
'@ifc-lite/create': patch
---

Fix the default `FILE_NAME` `time_stamp` written by `generateHeader` (used by every STEP export that does not pass an explicit `timeStamp`) and by `IfcCreator.toIfc()`'s header. Both stamped the current instant as `new Date().toISOString().replace(/[-:]/g, '').split('.')[0]` — e.g. `20260829T140835` — instead of the ISO 8601 date-time (`2026-08-29T14:08:35`) ISO 10303-21's `time_stamp` calls for and every other stamp in this codebase already uses. Stripping the separators also discarded the trailing `Z` along with the milliseconds it was cut for, leaving a UTC instant relabelled with no timezone designator at all.
