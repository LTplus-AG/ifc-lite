---
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": patch
---

Bulk "Set Attribute" now writes the attribute (#5867).

`BulkQueryEngine`'s `SET_ATTRIBUTE` action used to be skipped for every entity, so a run reported success with nothing changed. It now writes through `MutablePropertyView.setAttribute`, the same path the Properties panel uses, and records the overlay value it replaces so the run undoes cleanly.

`SET_ATTRIBUTE.attribute` takes the exact EXPRESS attribute name, one of the new `BULK_WRITABLE_ATTRIBUTES` export (`Name`, `Description`, `ObjectType`, `Tag`). The old lower-case spellings (`name`, `description`, `objectType`) never wrote anything and are now refused. An entity whose class does not declare the attribute (for example `ObjectType` on a type object) fails the run with a per-entity error instead of being skipped silently. The Bulk editor offers the same list, `Tag` included.
