---
"@ifc-lite/mutations": patch
---

CSV import (`CsvConnector`) now matches rows against the session's effective model (#5198). Previously every match strategy (GlobalId, Express ID, Name, Tag and `property`) enumerated the base entity table. So an entity deleted this session was still matched, counted and written to, and those writes survived undo of the delete. An entity created this session could never be matched. Candidates now come from the shared effective-entity accessor: tombstoned entities are excluded, and overlay-created entities are included. A created entity matches by its authored GlobalId, Name and Tag (a queued attribute edit wins) and by its overlay property sets.
