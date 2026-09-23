---
"@ifc-lite/mutations": patch
---

`BulkQueryEngine` now selects from the session's effective model (#5249). An entity created this session is a bulk-edit candidate, matched by class and by its authored GlobalId and Name. A retyped entity is selected by its new class, not its parsed one. A queued Name edit is what `namePattern` matches. Deleted entities stay excluded (#5196).
