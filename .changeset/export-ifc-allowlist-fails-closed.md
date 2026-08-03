---
'@ifc-lite/mcp': minor
---

`export_ifc`'s `global_ids` allowlist reaches entities the session created, and fails closed when it matches nothing (#2012).

Two problems, and the second was the worse one. A mixed allowlist naming both a created and a parsed entity exported only the parsed one, because the exporter's visible-only closure could not see an overlay-created id — fixed in `@ifc-lite/export`. And an allowlist that matched **nothing** produced an empty ref set, which the export adapter reads as "no filter": asking to export one created entity wrote the entire model to disk and reported success. That now raises `ENTITY_NOT_FOUND` instead. Ids that match nothing while others do are reported in `unmatchedGlobalIds`, and the matched ones still export.

`foldedEntityCount` also stopped double-subtracting: with created-then-deleted entities now tombstoned, only tombstones that name a store entity are deducted.
