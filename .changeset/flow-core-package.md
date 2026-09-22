---
'@ifc-lite/flow': minor
---

New package: keyed-data graph runtime — `Item`/`List`/`Group`/`Table` values, ports that declare `item`/`list`/`group` access with key-matched lifting and lacing, a memoised scheduler with a structured run log, `*.flow.json` documents with validation and migrations, and element tracking: tracked nodes get create / update / keep per lane against a persisted set, vanished lanes are removed, sets whose node was deleted from the graph are removed on the next run, and GlobalIds derive from a user-visible tracking key.
