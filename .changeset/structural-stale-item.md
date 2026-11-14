---
"@ifc-lite/parser": minor
"@ifc-lite/create": minor
---

Structural derivation records provenance, and a new check reports derived members whose physical element moved (#9668). `applyStructuralDerivation` writes an `IfcLite_StructuralDerivation` property set on each curve member: the element's GlobalId and its analytical line at derive time, in world metres (`PlannedCurveMember.physicalAxis`). With `physicalAxes`, `structuralConsistencyIssues` adds the `structural-stale-item` rule: a member whose recorded element's line now lies more than `staleTolerance` (default `DEFAULT_STALE_TOLERANCE`, 1 mm) from the record. A move along the element's own axis is reported, which `structural-axis-drift` cannot see. Members without a record are not checked.
