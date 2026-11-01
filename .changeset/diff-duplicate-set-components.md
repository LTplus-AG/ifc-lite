---
"@ifc-lite/wasm": patch
"@ifc-lite/diff": patch
---

`buildComponentFingerprints` now keys every property and quantity set on an entity. When an entity carries two or more sets of the same name, the first keeps `pset:<Name>` and each later one gets an ordinal in the prefix, such as `pset#2:<Name>` or `qset#2:<Name>`. Previously the last set overwrote the others, so an entity could be reported `modified` with an empty `changedComponents` (#8136). Keys for entities without repeated set names are unchanged.
