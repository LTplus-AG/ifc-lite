---
"@ifc-lite/mutations": patch
---

Treat a null/unset property value as present, not absent. A property may legitimately exist with no value (e.g. an IFC boolean added from bSDD, which now starts unset rather than defaulting to `false`), so `MutablePropertyView` no longer reads `value === null` as "property does not exist":

- `deleteProperty` keys absence off existence (in-session pset membership), so an unset property is still deletable instead of the trash button being a silent no-op.
- `setProperty` classifies a write as `UPDATE_PROPERTY` vs `CREATE_PROPERTY` by whether the property already existed (not by null value), so undoing an edit to an unset property restores its prior unset state instead of deleting the whole property.
