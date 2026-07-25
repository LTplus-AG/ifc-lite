---
'@ifc-lite/lists': minor
---

Add a `zone` column/condition source (issue #1810): location-zone
classification (which user-defined 3D zone box an element falls into, plus a
"straddles" flag when its bounds cross a zone boundary) can now be surfaced as
a list column, grouped/sorted/exported, and used as a filter condition.

`ColumnDefinition.source` / `PropertyCondition.source` gain a `'zone'` variant
(`psetName` holds the zone-SET id, `propertyName` selects `Zone` (default) or
`Straddles`). `ListDataProvider` gains two new OPTIONAL accessors,
`getZoneAssignment` and `getZoneSetNames` — providers built before this change
simply resolve every `zone` column to `null`, so this is purely additive and
backward compatible.
