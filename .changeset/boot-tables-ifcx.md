---
"@ifc-lite/ifcx": patch
---

`BUILDING_ELEMENT_TYPES` is built only where it is referenced (the constant is pure-annotated), and the writer's attribute lookup is built on first use, so loading `@ifc-lite/ifcx` decodes no schema table. Same contents, in the same order.
