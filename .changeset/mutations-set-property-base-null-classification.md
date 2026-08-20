---
"@ifc-lite/mutations": patch
---

Fix `MutablePropertyView.setProperty()` misclassifying the first edit of an already-present-but-null base property (an unset Boolean parsed from the source IFC file, the same shape as issue #1107) as `CREATE_PROPERTY` instead of `UPDATE_PROPERTY`.

`propExistedBefore` relied on `oldValue !== null` plus an in-session `newPsets` check, but neither test covers a property that exists in the *base* property table with a null value: `getPropertyValue()` legitimately returns null for it before any edit. `deleteProperty()` already avoids this trap with its own `propExistsInBase` lookup against the base pset's property list; `setProperty()` now checks the same thing, so the mutation is correctly classified as an update — keeping the exported mutation type consistent for any consumer that treats CREATE vs UPDATE differently (e.g. an undo that should restore the prior unset state rather than deleting the property outright).
