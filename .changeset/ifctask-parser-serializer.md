---
"@ifc-lite/parser": minor
---

Add schedule-serializer + deterministic-GlobalId helpers.

**`serializeScheduleToStep(extraction, options)`** emits a `ScheduleExtraction`
back into IFC-STEP lines (`IfcWorkSchedule`, `IfcWorkPlan`, `IfcTask`,
`IfcTaskTime`, `IfcRelNests`, `IfcRelSequence`, `IfcLagTime`,
`IfcRelAssignsToControl`, `IfcRelAssignsToProcess`), resolving cross-entity
references by expressId and reporting per-type line counts in `stats`.
Pairs with the existing `extractScheduleOnDemand` to make schedule data
fully round-trippable through a STEP export.

**`deterministicGlobalId(seed)`** — 128-bit double-FNV-1a hash encoded as a
22-char IFC GlobalId. Deterministic (same seed ⇒ same id), collision-safe
across schedule-generation seeds, and exposed as a single source of truth
for every caller that previously kept a private copy of the algorithm.
