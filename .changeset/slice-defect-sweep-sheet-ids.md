---
"@ifc-lite/viewer": patch
---

Fix two dead-field defects found while adding coverage for #2802's zero-coverage store slices.

`sheetSlice`'s `clearSheet` reused the same `getDefaultState()` helper the store uses to seed its initial state, so clicking "clear sheet" reset `savedSheetTemplates` to `[]` along with the active sheet — silently deleting every saved template. `clearSheet` now preserves `savedSheetTemplates` across the reset.

`idsSlice`'s `clearIdsValidationReport` already reset `idsIsolateMode` when it invalidated the validation report, but its two siblings that also invalidate the report — `setIdsDocument` (loading a new IDS document) and `clearIdsDocument` — did not. The isolate-panel "pressed" state and the 3D isolation built from `idsIsolateMode` in `useIDS.ts` were left pointing at a report that no longer existed after loading or clearing a document. Both now reset `idsIsolateMode` and `idsIsolationScope` the same way `clearIdsValidationReport` does.
