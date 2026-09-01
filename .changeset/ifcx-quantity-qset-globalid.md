---
'@ifc-lite/ifcx': patch
---

`buildQuantities` now passes `qsetGlobalId: ''` explicitly when building `QuantityTable` rows, documenting (rather than silently defaulting) that IFCX's flat node-attribute model has no distinct backing qset entity with its own GlobalId — mirroring `property-extractor.ts`'s existing `psetGlobalId: ''`.
