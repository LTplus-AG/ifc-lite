---
"@ifc-lite/viewer": patch
---

A selector term like `IfcWall, 325Q7Fhnf67OZC$$r43uzK` — a class and a bare GlobalId in the same group — used to become one AND rule ("is a wall AND has that GlobalId"), so a GUID naming a non-wall element silently matched nothing. IfcOpenShell's selector unions additive facets like these rather than narrowing them (`IfcWall, <GUID>` means "all walls, plus that element regardless of its type"), which this adapter's AND-only rule model cannot express. This combination is now reported as unsupported instead of silently narrowed. The `!`-subtracted form (`IfcWall, ! <GUID>`) and a lone GlobalId term are unaffected — both were already correct.
