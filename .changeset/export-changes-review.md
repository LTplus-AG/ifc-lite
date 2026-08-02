---
"@ifc-lite/mutations": minor
---

Fix `MutablePropertyView.getModifiedEntityCount()` and `hasChanges()` to read the live overlay instead of the append-only `mutationHistory` (issue #1915). Undo does not pop `mutationHistory` — it either re-applies the inverse or clears the overlay entry directly — so after an undo, `getModifiedEntityCount()` could over-report entities that no longer have any pending change, disagreeing with `hasPendingChanges()`. Both methods now agree with `hasPendingChanges()` in every case, including entities restored via `restoreNewEntity` (which never touches `mutationHistory` at all).

Add `getEffectiveChanges()`, returning every change the overlay currently carries — attribute, property, quantity, pset/qset add-or-delete, retype, and entity create/delete — with `previousValue` derived from the base data (property table / on-demand extractor / the new optional `AttributeExtractor`, set via `setAttributeExtractor()`), never from `mutationHistory`, so an undo→redo cycle reports the true original value instead of a stale history entry. Backs the export-review dialog in `@ifc-lite/viewer`, which lets a user see what an "Export Changes" click will actually apply before committing to it.
