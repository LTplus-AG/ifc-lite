---
"@ifc-lite/create": patch
---

`resolveDuplicateSource` resolved a source element's IFC type (and each of its cloned property/type/material association rels) via `store.entities.getTypeName(id) || fallback`. `getTypeName` answers the literal string `'Unknown'` — not `null`/`undefined` — for entities the columnar `EntityTable` doesn't carry rows for, which notably includes property/association relationship entities. Since `'Unknown'` is truthy, the `||` fallback never fired, so duplicating any imported element with an attached pset, type binding, material, classification, or document produced an association rel typed literally `'Unknown'` and the duplicate flow threw `type "Unknown" is not a recognizable IFC entity name` (#4933). Both lookups now explicitly test for the `'Unknown'` sentinel before falling back to the STEP-parsed raw type, and `resolveDuplicateSource` refuses with a named reason if even that is unresolvable, instead of ever emitting an `'Unknown'`-typed entity.
