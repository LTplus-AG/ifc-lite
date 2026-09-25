---
"@ifc-lite/export": patch
---

STEP export copies a shared property set on write (#5794). Editing an `IfcPropertySet` or `IfcElementQuantity` that one `IfcRelDefinesByProperties` relates to several elements now gives only the edited element its own set and relation, and removes it from the shared relation's `RelatedObjects`; the other elements keep the original set. A type-owned set that another type object's `HasPropertySets` still names is also kept, where it used to be dropped and left that type pointing at a missing record. Before, the shared relation and set were dropped, so every other element lost the set. The regenerated set also references the source member of every property the session did not edit, so list, enumerated, bounded, table, reference and complex properties keep their IFC class instead of being written back as single-value text.
