---
'@ifc-lite/cache': patch
---

Fix the cache-rehydrated `PropertyTable.getForEntity` (`readProperties`) silently merging two distinct `IfcPropertySet` instances into one when they share a literal name -- the same bug just fixed in `@ifc-lite/data`, but in a second, byte-for-byte-duplicate grouping loop that only ran on a model loaded from the binary cache. A model with two same-named pset instances (a federated merge, or an exporter emitting the same `Pset_` twice on one element) answered correctly from a fresh parse but merged them into one set, misattributing the second instance's properties to the first instance's GlobalId, once reloaded from cache. Both paths now call the same `@ifc-lite/data` grouping helper (`groupPropertySetsByInstance`, keyed on `(psetName, psetGlobalId)`), so a cache-loaded model can no longer diverge from a fresh parse.
