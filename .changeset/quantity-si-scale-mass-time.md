---
"@ifc-lite/parser": patch
---

`quantitySiScale` now scales an `IfcQuantityWeight` or `IfcQuantityTime` without its own `Unit` by the project's `MASSUNIT`/`TIMEUNIT`. It returned `1` for both, so a value in a tonne or minute project was read as kilograms or seconds when converted to SI, compared across files, or re-expressed in project units for lists (#11469).
