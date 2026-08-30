---
'@ifc-lite/export': minor
---

`exportAnonymizedSubset` no longer leaks property sets that reach `includedIds` outside the viewer's coupled toggles or the CLI's `--keep-psets` (#3351). `keepPropertySets: false` (the default) previously only cleared an `IfcTypeObject`'s `HasPropertySets` slot — a property set an `IfcRelDefinesByProperties` walk (or a hand-built `includedIds`) added directly still exported complete, values included. The orchestrator now excludes any `IfcPropertySet`/`IfcElementQuantity` id from the subset unless `keepPropertySets` is `true`, the same way the CLI already behaved, and reports what it dropped as `AnonymizeResult.stats.droppedPropertySetIds`.
