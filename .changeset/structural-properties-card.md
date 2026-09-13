---
"@ifc-lite/viewer": minor
---

Added a Structural Analysis card to the Inspector's Properties tab. Selecting an `IfcStructuralMember` (curve or surface) now shows its analysis model, the connections it is joined to (with the boundary condition's fixed/free degrees of freedom when the file carries one), and the loads applied to it through its activities. The card reads `extractStructuralOnDemand`'s existing read model on demand, the same way `ScheduleCard` reads the schedule extraction, and surfaces `loadsTruncated` as a "Truncated" badge rather than presenting a bounded load walk as complete.

This is the properties-card layer of #4206's six-layer structural analysis stack (semantic extraction, the read model, `bim.structural`, this card). Geometry (structural curve/surface members carry `IfcTopologyRepresentation`, not solids, and need a new extraction path) and write/round-trip remain out of scope for this change.
