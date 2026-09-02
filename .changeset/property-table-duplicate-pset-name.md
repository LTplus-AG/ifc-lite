---
'@ifc-lite/data': minor
---

Fix `PropertyTable.getForEntity` silently merging two distinct `IfcPropertySet` instances into one when they share a literal name, misattributing the second instance's properties to the first instance's GlobalId.

An entity can carry two rows whose `psetName` is identical but whose `psetGlobalId` (the real property-set identity) differs — a federated merge of two files, or an exporter that emits the same `Pset_` twice on one element, both produce this. `getForEntity` grouped rows into a `Map<string, PropertySet>` keyed on `psetName` alone, so the second instance's rows landed in the first instance's bucket and the returned `PropertySet.globalId` answered the wrong pset for them — a silent identity mix-up, not a crash. `getForEntity` now groups on `(psetName, psetGlobalId)`, so two same-named-but-distinct instances stay separate while rows that genuinely belong to one instance still merge exactly as before.
