---
'@ifc-lite/parser': minor
---

The viewer's Lens (coloring/filtering rules) resolved type-inherited PROPERTY sets but not type-inherited QUANTITY sets: `getQuantityValue`/`getQuantitySets` looked only at an occurrence's own `IfcElementQuantity` sets, so a `Qto_*` set attached to the element's `IfcTypeProduct` (e.g. `Qto_WallBaseQuantities` on `IfcWallType` rather than each `IfcWall`) was invisible to every quantity-based Lens rule and absent from the rule builder's own set/quantity discovery, even though IFC inherits quantities exactly like properties. Adds `mergeInheritedQuantitySets` (the quantity counterpart of `mergeInheritedPropertySets`: occurrence wins per quantity name, not per whole set) and uses it in `apps/viewer/src/lib/lens/adapter.ts`.
