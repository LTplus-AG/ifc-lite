---
"@ifc-lite/rules": minor
"@ifc-lite/viewer": minor
---

A new `group` filter rule matches membership in an `IfcGroup` through `IfcRelAssignsToGroup`, e.g. "every AHU is assigned to a system". Presence (`isSet` / `isNotSet`) means assigned to any such group, named or not. The name ops match the group's Name. An optional `groupClass` narrows the match to groups of one IFC class, subclasses included (`IfcSystem` also covers `IfcDistributionSystem`). The rule works in search, in rule-set applicability, and in `element` requirements. `group` is also a subject for `unique` and `aggregate … by group`. The viewer's rule builders offer it as "Group".
