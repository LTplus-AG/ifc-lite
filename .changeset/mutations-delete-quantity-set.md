---
"@ifc-lite/mutations": minor
---

`MutablePropertyView.deleteQuantitySet(entityId, qsetName)` - the inverse of `createQuantitySet`, and the exact mirror of the `deletePropertySet` that has always existed one level up.

It was missing, which is why `deletedQsets` was read by `getQuantitiesForEntity`, `hasPendingChanges` and `collectSetLevelChanges` while nothing populated it outside the restore path. Without it, a writer that REPLACES an entity's quantity set can shrink it but never empty it: re-running with nothing left to write leaves the previous run's numbers standing. #2508's zone write-back hits that directly, where it produces a file stating cubic metres beside a property saying the volume could not be computed.

It records its own `DELETE_QUANTITY_SET` mutation type rather than a `DELETE_QUANTITY` with no property name: both replay consumers (`applyMutations` and `change-set-to-ops`) key the member-delete case off the property name, so a whole-set removal filed under it matched nothing, resurrected the set on import and vanished from a layer publish without reaching `skipped`.

Semantics follow `deletePropertySet`: an in-session quantity set is dropped along with the per-quantity mutations its creation recorded, and a DELETE marker is recorded only against a set that genuinely exists in the base file, so a create-then-delete in one session nets to no reported change.

Paired with it, `MutablePropertyView.isQuantitySetDeleted(entityId, qsetName)`: `getQuantitiesForEntity` reports a deleted set and a never-existing one identically, and the STEP exporter needs the difference. It withholds a source `IfcElementQuantity` when it is writing a replacement for it, and a deletion has no replacement to be recognised by, so without this a set the session deleted was still in the exported bytes.
