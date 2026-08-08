---
"@ifc-lite/mutations": patch
---

Fix `MutablePropertyView.setQuantity()` reporting a wrong `oldValue`/mutation type on the first edit of an already-existing base quantity.

Before this fix, `oldValue` was resolved only from a prior overlay mutation for the same key (`this.quantityMutations.get(key)?.value`), never from the base quantity's own value — unlike `setProperty()`, which resolves `oldValue` via `getPropertyValue()` (overlay-or-base). So editing a base quantity for the first time produced `{ type: 'UPDATE_QUANTITY', oldValue: null }` even though a real prior value existed. Consumers that gate reverting a quantity edit on `oldValue` being non-null (e.g. `apps/viewer`'s undo handler) silently did nothing on undo — the same "reports success, reverts nothing" shape as #2297, but for quantities, and in `@ifc-lite/mutations` rather than `@ifc-lite/mcp`.

A second, related defect: adding a *new* quantity name to an already-existing quantity set was classified as `UPDATE_QUANTITY` (since `qsetExistsInBase` was checked instead of the specific quantity), so undo of that create also tried to restore a nonexistent prior value instead of removing the mutation.

`setQuantity()` now resolves `oldValue`/the CREATE-vs-UPDATE classification from the overlay mutation when present, falling back to the specific base quantity's value (existence keyed on quantity name, not just qset name) — mirroring `setProperty()`'s existing resolution order.
