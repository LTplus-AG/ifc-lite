---
'@ifc-lite/parser': patch
---

Fix `extractTypeQuantitiesOnDemand` (and its property counterparts, `extractTypePropertiesOnDemand`/`extractTypeEntityOwnProperties`) silently dropping a type-level property/quantity set when it shares a literal name with one already collected from the other source (#3722) — the same defect shape #3603 and #3606 fixed for `PropertyTable.getForEntity`/`QuantityTable.getForEntity`, in a third, independent place.

A type can carry two distinct `IfcElementQuantity`/`IfcPropertySet` instances that share a name: one reachable via its `HasPropertySets` attribute, one via a separate `IfcRelDefinesByProperties` (the shape a federated/merged export produces). The shared merge helper `appendSetsFromSecondSource` already dedupes the second source against the first by express id, but then also dropped any second-source set whose *name* collided with a first-source name — even when the two were provably distinct instances. Anything reading type-inherited quantities or properties (quantity takeoff, an IDS facet against a type) silently lost the second instance's data.

`appendSetsFromSecondSource` now dedupes on `(name, globalId)` identity — via a new `setIdentityKey` helper using the same NUL-separated key shape `@ifc-lite/data`'s `groupPropertySetsByInstance`/`groupQuantitySetsByInstance` use — instead of name alone, so two distinct same-named instances both survive. A genuinely duplicate set (same name AND the same GlobalId, reachable both ways) still collapses to one, as before.
