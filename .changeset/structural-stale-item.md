---
"@ifc-lite/parser": minor
"@ifc-lite/create": minor
---

Structural derivation records provenance, and a new check reports derived members whose physical element moved (#9668). `applyStructuralDerivation` writes an `IfcLite_StructuralDerivation` property set on each curve member: the element's GlobalId and its analytical line at derive time (`PlannedCurveMember.physicalAxis`), recorded in metres in the storey's axes, so moving a storey or site that carries both the element and the member reports nothing. With `physicalAxes`, `structuralConsistencyIssues` adds the `structural-stale-item` rule: a member whose recorded element's line now lies more than `staleTolerance` (default 1 mm) from the record. A move along the element's own axis is reported, which `structural-axis-drift` cannot see. Members without a record are not checked. `PlannedCurveMember.physicalAxis` is optional: a plan without it applies as before and writes no record.
