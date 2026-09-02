---
'@ifc-lite/create': patch
---

`addIfcElementQuantity` wrote `IfcQuantityLength`/`Area`/`Volume`/`Weight`/`Count` records with only 4 attributes (`Name`, `Description`, `Unit`, `<Value>`) instead of the 5 the schema declares — `IfcPhysicalSimpleQuantity`'s trailing `Formula` attribute was omitted entirely rather than written as an unset `$`. STEP part 21 requires every declared attribute position to be present (`$` for unset), so the emitted record was one field short of what `IfcQuantityLength`/etc. need; a strict reader can reject the entity outright. Every quantity attached via the public `addIfcElementQuantity` API now writes the trailing `$` for `Formula`.
