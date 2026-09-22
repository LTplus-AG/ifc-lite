---
"@ifc-lite/export": patch
---

Fix a dangling reference on export when a single `IfcProperty` or `IfcPhysicalQuantity` is deleted while its parent `IfcPropertySet`/`IfcElementQuantity` survives. The non-relationship dangling-ref scrub's type list is now derived from the generated schema registries instead of a hand-kept set, closing this gap and any others of the same shape.
