---
"@ifc-lite/mcp": patch
---

Fix `mutation_undo` reporting mutations as reverted while leaving the overlay untouched. It only trimmed `MutablePropertyView`'s append-only mutation-history array (documented in `@ifc-lite/mutations` as *not* poppable for undo) and never reverted the actual property/attribute/entity overlay state, so a caller that undid an edit and then read the entity back still saw the edited value — the tool claimed success on an operation that did nothing. `mutation_undo` now applies the inverse of each reverted mutation (property set/create/delete, attribute set, entity create/delete) to the live overlay, mirroring the viewer's undo-stack dispatch.

Also fixes `entity_set_attribute` never recording the attribute's prior value in its mutation record, so any consumer of `Mutation.oldValue` (including the undo above) restored to an empty value instead of the true original.
