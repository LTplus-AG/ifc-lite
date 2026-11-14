---
"@ifc-lite/ifcx": patch
---

`BUILDING_ELEMENT_TYPES` is built only where it is referenced (the constant is pure-annotated), and the writer's attribute lookup is built on first use, so in a bundle loading `@ifc-lite/ifcx` decodes no schema table (In a bundle; an unbundled Node import still evaluates the exported table constants when their modules load.) Same contents, in the same order.
