---
'@ifc-lite/drawing-2d': patch
---

Fix `OpeningInfo.windowPartitioning` never being populated for window openings, so 2D drawing generation silently rendered every window with a single-panel symbol.

`OpeningRelationshipBuilder.build()` extracted `doorOperation` from the filling element's properties when `type === 'door'`, but had no equivalent extraction for `windowPartitioning` when `type === 'window'` — the field existed on `OpeningInfo` and was read by `window-symbol.ts` (`opening.windowPartitioning ?? 'SINGLE_PANEL'`), but the producer never set it, so the `?? 'SINGLE_PANEL'` fallback fired unconditionally. A window with `PartitioningType: DOUBLE_PANEL_HORIZONTAL` (or any other `IfcWindowTypePartitioningEnum` value) drew identically to a plain single-panel window in generated 2D plans/elevations — a silent, plausible-looking wrong symbol rather than a crash or an obviously-missing one.

`OpeningRelationshipBuilder` now extracts `PartitioningType` from the filling element's properties (checking the direct attribute first, then `Pset_WindowCommon`, mirroring `extractDoorOperation`'s lookup for doors) and assigns it to `windowPartitioning` for window-type openings.
