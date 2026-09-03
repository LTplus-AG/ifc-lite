---
'@ifc-lite/parser': minor
---

New exports `roundToScale(value)` and `scaledPropertyValue(value, dataType, projectUnits)`: the exact base-SI-scale-then-round transform every model-diff fingerprint adapter (CLI, viewer, MCP) applies to a measure-typed `IfcPropertySingleValue` before hashing it, factored out of three near-identical local copies (`scaleMeasureValue` + a private 4-decimal round) so the three adapters cannot drift the way three independent copies would. No behaviour change — same scale, same rounding, same call sites.
