---
"@ifc-lite/parser": patch
---

`schedule-extractor.ts` now reads an `IfcRelNests` relation whose `RelatingObject`
is an `IfcWorkPlan` nesting `IfcWorkSchedule`s — `WorkScheduleInfo` gained
`childScheduleGlobalIds` (on the plan) and `parentPlanGlobalId` (on the
schedule) to carry it. Previously the `IfcRelNests` pass only resolved a
nesting parent through the task table, so a plan grouping schedules was
silently dropped on load with no trace in the extraction result.

`schedule-serializer.ts` now emits that `IFCRELNESTS` relation on export from
`WorkScheduleInfo.childScheduleGlobalIds`; previously it wrote `IFCRELNESTS`
only for task/subtask hierarchy, so an authored `IfcWorkPlan` never grouped
its schedules in the written STEP.

Found by comparing against buildingSMART's own IFC4 spec reference file for
`IfcTask`, which uses this exact pattern. ifc-lite's own round-trip suite
couldn't see the gap: it round-trips the writer through the reader, so a
relation the writer never emitted couldn't appear as a mismatch there.
