---
"@ifc-lite/data": minor
"@ifc-lite/query": patch
"@ifc-lite/cache": patch
---

fix(query): scope `whereProperty` to the named property set

`EntityQuery.whereProperty(psetName, propName, ...)` recorded the property-set
name but never passed it to `findByProperty`, so a property matched in *any*
property set — e.g. filtering `Pset_WallCommon.IsExternal` also returned doors
whose `Pset_DoorCommon.IsExternal` matched. `findByProperty` gains an optional
`psetName` argument (honored by the in-memory, cache-restored, and
server-converted property tables), and `whereProperty` now passes it. An unknown
pset name matches nothing.
