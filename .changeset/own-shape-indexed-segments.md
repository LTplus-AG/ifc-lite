---
"@ifc-lite/data": major
"@ifc-lite/parser": major
"@ifc-lite/mutations": major
"@ifc-lite/export": minor
---

Typed STEP attribute markers also accept positive integer arrays for `IfcLineIndex` and `IfcArcIndex`, preserving IFC4 indexed-polycurve segments when copying a file element with its own shape. Invalid segment aggregates refuse export.

Breaking type change: code reading `value.typed.value` must now narrow arrays before treating the payload as a scalar. For scalar-only consumers, use `!Array.isArray(value.typed.value)` before reading it as `string | number | boolean`.
