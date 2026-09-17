---
"@ifc-lite/parser": patch
"@ifc-lite/cli": patch
---

An explicit empty `Category` (`''`) on an `IfcCostValue` with no `AppliedValue` and no `Components` is no longer evaluated as a category total; it reports `MISSING_VALUE` as before. `ifc-lite eval --type` labels an entity whose `Name` is empty by its `GlobalId` (#4881).
