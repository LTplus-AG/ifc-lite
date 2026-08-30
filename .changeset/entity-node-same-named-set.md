---
'@ifc-lite/query': patch
---

`EntityNode.property()` and `EntityNode.quantity()` dropped a property or quantity that lived only on the second of two same-named sets on an entity, returning `null` instead.

Two distinct `IfcPropertySet` (or `IfcElementQuantity`) entities sharing the same `Name` is a legitimate model shape — two separate `IfcRelDefinesByProperties` relationships pointing at two different sets that happen to be named alike. The on-demand extraction path used for a raw STEP parse returns one array entry per underlying set rather than merging same-named ones (unlike the columnar `PropertyTable`'s `getForEntity`, which does merge them), so `store.getProperties()`/`store.getQuantities()` can legitimately return two entries with the same `name`.

`property()` and `quantity()` both used `.find(p => p.name === setName)`, which stops at the first same-named set. If that particular set instance lacked the requested property/quantity, the method returned `null` even though a later set with the same name carried it — the same defect fixed in `PropertyTable.getProperty` (#2907), left unfixed in `EntityNode`'s own read path. Both methods now check every same-named set before giving up.
