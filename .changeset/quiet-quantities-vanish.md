---
"@ifc-lite/mutations": patch
---

Fix silent data loss for whole-property-set and whole-quantity-set creations (`StoreEditor.addPropertySet` / `addQuantitySet`, or the underlying `MutablePropertyView.createPropertySet` / `createQuantitySet`) in two downstream consumers of `Mutation` records.

`createPropertySet()` and `createQuantitySet()` each record a single `CREATE_PROPERTY_SET` / `CREATE_QUANTITY` mutation for the whole set, carrying the full member array on `newValue` — unlike `setProperty()` / `setQuantity()`, which always record `psetName` **and** `propName` together for one member at a time.

- `changeSetToOps()` (the layer-publish bridge in `change-set-to-ops.ts`) treated `CREATE_PROPERTY_SET` as "materialize an empty component; members follow" — but for this whole-set form nothing else in the change set ever populated the values, so the published op carried `values: {}` and every property the user entered was dropped from the layer. The `CREATE_QUANTITY`/`UPDATE_QUANTITY` case required `propName`, so the whole-set form matched the case and produced nothing at all — not even a `skipped` entry, so the loss was invisible.
- `MutablePropertyView.applyMutations()` (backing `exportMutations()` → `importMutations()`) had the same `psetName && propName` gap for `CREATE_QUANTITY`, so a `createQuantitySet()` batch silently vanished on round trip through a fresh view.

Both paths now read the member array off `newValue` for the whole-set form, mirroring the per-member fold. No change to the per-member (`setProperty`/`setQuantity`) mutation shapes.
