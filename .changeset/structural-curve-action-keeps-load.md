---
"@ifc-lite/create": patch
---

Removing an `IfcStructuralCurveAction` keeps its borrowed load; in loaded files, that load may remain after the action is removed and can be removed separately.
