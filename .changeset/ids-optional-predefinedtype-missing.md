---
"@ifc-lite/ids": patch
---

Fix `optional` requirements incorrectly failing when a nested `predefinedType` constraint is checked against an entity (or, for `partOf`, a related entity) that has no predefined type at all.

Per IDS semantics, `optional` means "if present, must satisfy" — a wholly absent attribute passes, same as `ATTRIBUTE_MISSING`/`PROPERTY_MISSING`/etc. already do. `PREDEFINED_TYPE_MISSING` and `PARTOF_PREDEFINED_TYPE_MISSING` were left out of that "wholly absent" allow-list, so an `optional` entity or `partOf` requirement with a `predefinedType` sub-constraint reported `fail` instead of `pass` whenever the target had no predefined type data — the opposite of what `optional` promises.
