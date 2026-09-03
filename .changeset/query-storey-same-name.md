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
resolves an exact `Name` to every storey with that name and unions their
contained elements. A substring match unions its storeys only when they all
share one `Name`; a substring spanning differently named storeys (`"Level"`
against `Level 1` and `Level 2`) exits 1 and lists the candidate names instead
of silently merging or arbitrarily picking one. A single unique storey name
behaves exactly as before.
