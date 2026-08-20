---
"@ifc-lite/query": patch
---

Fix `PropertyTable.getProperty` returning null when an entity carries two property sets with the same name and the property lives only on the second one.

`getProperty` stopped scanning at the first pset whose name matched, and returned whatever that pset had for the property (`null` if it lacked it) instead of continuing to the next same-named pset. `findEntities`, right below it in the same class, already handled two same-named psets correctly by scanning all of them; `getProperty` now does the same — it keeps checking subsequent same-named sets until it finds the property, matching the semantics IFC's `IfcRelDefinesByProperties` allows (an entity can be targeted by more than one property set sharing a name).
