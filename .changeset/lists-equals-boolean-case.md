---
"@ifc-lite/lists": patch
---

Fix `equals`/`notEquals` list conditions being case-sensitive for boolean-like values, while their `contains` sibling was already case-insensitive. An `IfcBoolean` property displays as `"True"`/`"False"`, and a location-zone `Straddles` condition resolves to a raw JS boolean that stringifies as `"true"`/`"false"` — a condition typed as `IsExternal = true` (or a saved zone `Straddles = True` filter) could silently fail to match, and the equivalent `notEquals` condition could silently include rows that only differed by letter case.

The fix is scoped to values that look like a boolean/logical (`"true"`/`"false"`/`"unknown"`, any case, or a genuine JS boolean) on both sides of the comparison. Every other value type — GlobalId, Name, classification codes, spatial container names, and any other string property — keeps the original exact, case-sensitive comparison, since e.g. two distinct IFC GlobalIds can differ only by case.
