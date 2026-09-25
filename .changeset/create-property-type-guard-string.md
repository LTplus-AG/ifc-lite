---
"@ifc-lite/create": patch
---

`addIfcPropertySet` now rejects a malformed `Type` on a string property too, as it already did for numbers, so the type name can't be spliced into the STEP line. An empty `Type` (a JSON payload that defaults an unset field to `''`) is treated as undeclared and no longer throws.
