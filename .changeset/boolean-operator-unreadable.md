---
"@ifc-lite/wasm": patch
---

An `IfcBooleanResult` whose `Operator` is `$` (or anything that is not an enum) is no longer executed as a DIFFERENCE. UNION and INTERSECTION are as legal there, so the host comes back un-cut and an `UnknownBooleanOperator` diagnostic is recorded. `IfcBooleanClippingResult`, where DIFFERENCE is the only legal operator, still clips. A boolean chain whose intermediate result meshes empty no longer ends early for UNION: `UNION(empty, B)` now renders `B`, and the emptied operand is recorded once.
