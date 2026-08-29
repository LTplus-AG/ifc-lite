---
'@ifc-lite/query': patch
---

Fix `PropertyTable.getProperties` (and `QueryInterface.getProperties`, which calls through it) silently dropping a property set when an entity carries two `IfcPropertySet`s that share the same name.

An entity can legitimately carry two same-named property sets — two `IfcRelDefinesByProperties` pointing at distinct `IfcPropertySet`s. `getProperty` already scans every same-named set for this exact shape (#2907). `getProperties` did not: it keyed its result by pset name alone, so the second same-named set silently overwrote the first in the returned `Map`, and every property that lived only in the overwritten set vanished with no signal that anything went missing.

Same-named sets are now merged into one entry per name, with the earlier set's values winning on a key collision — matching `getProperty`'s own first-match-wins order.
