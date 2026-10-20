---
"@ifc-lite/wasm": patch
---

Correct sloped IfcBooleanResult DIFFERENCE cuts with coincident sides, including adjacent stacked cutters.

Reject budget-aborted zone computations through the existing `undefined` (no split) result instead of reporting a successful empty split or whole-host remainder.
