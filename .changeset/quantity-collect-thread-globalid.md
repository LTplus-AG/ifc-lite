---
'@ifc-lite/parser': patch
---

Thread `IfcElementQuantity.GlobalId` through `readQuantitySet` (`CollectedQuantitySet.globalId`) and the on-demand quantity extractors (`extractQuantitiesOnDemand`, `extractQsetsFromIds`, `TypeQuantityInfo.quantities`), so callers can distinguish two same-named-but-distinct quantity-set instances on one entity — feeding `@ifc-lite/data`'s `QuantityTable.getForEntity` identity fix. The field is optional and additive; no existing caller's behavior changes.
