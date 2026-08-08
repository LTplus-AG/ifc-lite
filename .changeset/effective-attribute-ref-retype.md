---
"@ifc-lite/export": patch
---

Fix `EffectiveEntityIndex.effectiveAttributeRef` resolving an overlay-created entity's named attribute by its *authored* type instead of its *effective* (post-retype) type.

`effectiveAttributeRef`'s positional fallback looked up an attribute's schema position via `getAllAttributesForEntity(entity.type)`, where `entity.type` is the type the record was created as — ignoring `this.retypes`, the same map `effectiveType` already consults. For an entity retyped after creation (e.g. `IfcRelAggregates` retyped to `IfcRelVoidsElement`), a lookup for an attribute name that exists only in the new type's schema (`RelatingBuildingElement`) found no match in the old schema and returned `undefined`. This broke `propagateOpeningExclusions`' opening-exclusion propagation for a `visibleOnly` export: an opening whose retyped `IfcRelVoidsElement` names a hidden host was not excluded, because the relation's host could not be resolved.
