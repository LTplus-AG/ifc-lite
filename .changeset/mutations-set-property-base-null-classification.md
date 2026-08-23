---
"@ifc-lite/mutations": patch
---

Fix `MutablePropertyView.setProperty()` misclassifying the first edit of an already-present-but-null base property (an unset Boolean parsed from the source IFC file, the same shape as issue #1107) as `CREATE_PROPERTY` instead of `UPDATE_PROPERTY`.

`propExistedBefore` relied on `oldValue !== null` plus an in-session `newPsets` check, but neither test covers a property that exists in the *base* property table with a null value: `getPropertyValue()` legitimately returns null for it before any edit. `deleteProperty()` already avoids this trap with its own `propExistsInBase` lookup against the base pset's property list; `setProperty()` now checks the same thing, so the mutation is correctly classified as an update — keeping the exported mutation type consistent for any consumer that treats CREATE vs UPDATE differently (e.g. an undo that should restore the prior unset state rather than deleting the property outright).

The base-pset lookup only counts a row that is still visible: a property the user has already deleted — directly, or by deleting its whole pset — is masked out of `getForEntity()`, so re-setting it stays a `CREATE_PROPERTY`. Otherwise undoing that re-set would replay `oldValue: null` and bring the deleted property back as a present-but-unset row instead of removing it.
