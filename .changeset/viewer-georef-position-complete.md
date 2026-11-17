---
"@ifc-lite/viewer": patch
---

An edit to the map position that leaves Eastings, Northings or OrthogonalHeight unset (a map pick without terrain height, the true-north angle, a single field) now stores the missing coordinates as 0 in the same undo step, where the panel shows them, so the export writes a complete IfcMapConversion instead of being refused. Reverting a change from the Changes panel is refused when it would leave a position incomplete.
