---
'@ifc-lite/ids': patch
---

Fix the IDS property overlay resolver manufacturing an empty-string `dataType` (`''`) for a property created by a correction that didn't supply one. `''` is falsy exactly like `undefined` at the property facet's dataType gate, so a `PROPERTY_MISSING` correction made without a dataType silently disabled every subsequent dataType-constrained IDS check on that property. The resolver now carries `undefined` through unchanged, matching the parser's own deliberate `undefined` for multi-typed properties (`IfcPropertyTableValue`).

This does not change the property facet's dataType gate itself, which still skips the dataType requirement when no dataType is recorded (falls through to a pure value match) — that behaviour is unchanged and still covers the legitimate `IfcPropertyTableValue` case.
