---
"@ifc-lite/cli": patch
---

`validate` walked past every `*StandardCase` and `*ElementedCase` element in two of its rules.

`store.entityIndex.byType` is keyed by the raw STEP type name, so an `IfcWallStandardCase` sits in its own bucket, not under `IFCWALL`. Both element-scanning rules read that index from a hand-written list of type names, and both lists were short.

`named-elements` listed thirteen base types and not one subtype, so **all ten** of `IfcWallStandardCase`, `IfcWallElementedCase`, `IfcSlabStandardCase`, `IfcSlabElementedCase`, `IfcColumnStandardCase`, `IfcBeamStandardCase`, `IfcDoorStandardCase`, `IfcWindowStandardCase`, `IfcMemberStandardCase` and `IfcPlateStandardCase` were invisible to it. An IFC4 file whose walls are all `IfcWallStandardCase` — which is what several exporters write — reported zero unnamed elements no matter how many had no Name.

`quantity-completeness` did spell six subtypes out by hand, and had drifted four short: `IfcWallElementedCase`, `IfcSlabElementedCase`, `IfcMemberStandardCase` and `IfcPlateStandardCase` were left out of both the numerator and the denominator, so the reported "N/M building elements have no quantity sets" percentage was computed over the wrong population.

Both lists are now `expandTypes(...)` of a base list — the same expansion `byType()` uses on all three backends — so these rules and a `byType('IfcWall')` query cannot disagree about what counts as a wall, and the tables cannot fall behind the schema again. Which *base* types each rule scans is unchanged: that is a policy choice, and the existing asymmetry (`IfcRailing` is checked for a Name but not for quantities) is preserved.

Same shape as #3229, where `IFC_SUBTYPES` itself had drifted; found by the same mechanical diff against the generated schema registry.
