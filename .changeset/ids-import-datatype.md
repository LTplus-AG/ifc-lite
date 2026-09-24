---
"@ifc-lite/rules": minor
"@ifc-lite/viewer": patch
---

`idsToRuleSet` now imports a property facet that carries a `dataType` instead of refusing it. The rules don't check the data type, and each dropped check is listed in the new `droppedChecks` result field. The Data validation panel shows them under "Imported without these checks".
