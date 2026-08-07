---
"@ifc-lite/ifcx": patch
---

Fix `composeIfcx` and `composeFederated` dropping a `children: { name: null }` removal opinion when the same node also has an `inherits` reference that defines a child of the same name. Attribute removals already survived flattening as a mask so they shadow an inherited value (#1031); the identical `children` removal was deleted at flatten/merge time instead of preserved, so the inherited child silently reappeared in the composed tree. Children now use the same mask-and-resolve pattern as attributes in both composers, so an explicit `null` removes an inherited child too, and a later non-null opinion still resurrects it.
