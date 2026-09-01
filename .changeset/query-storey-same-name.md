---
'@ifc-lite/cli': patch
---

Fix: `ifc-lite query --storey <name>` no longer drops elements from a second storey that shares the same `Name`.

`IfcBuildingStorey.Name` is not unique — two storeys legally share a `Name` as
siblings under different buildings, and a malformed or federated file can
duplicate a level name outright. `--storey` resolved its argument to a single
storey via `Array.find`, so when two storeys shared a `Name` only the first one
(by internal array order) was used; every entity in the second, same-named
storey was silently excluded from the result with no error and no warning.

`--storey` now resolves an unambiguous `expressId` to exactly one storey, but
resolves a `Name` (exact or substring match) to every storey with that name and
unions their contained elements. A single unique storey name behaves exactly as
before.
