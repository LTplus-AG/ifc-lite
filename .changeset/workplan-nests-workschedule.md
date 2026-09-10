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

`schedule-extractor.ts`'s `IfcRelAssignsToControl` pass now also resolves a
`WorkPlan` grouping a `WorkSchedule` through that relation (the SDK's
`assignSchedulesToWorkPlan` bridge in `packages/create/src/ifc-creator.ts`
emits exactly this relation, not `IfcRelNests`) into the same
`childScheduleGlobalIds` / `parentPlanGlobalId` fields — previously that pass
only resolved `RelatedObjects` through the task table too, so an
SDK-authored plan grouping was silently dropped on load the same way. A file
that groups the same pair through both relations is not double-counted. The
serializer still canonicalizes every grouping to `IFCRELNESTS` on write, so a
plan grouped via either relation survives an edit-triggered
strip-and-regenerate round trip.

Found by comparing against buildingSMART's own IFC4 spec reference file for
`IfcTask`, which uses this exact pattern. ifc-lite's own round-trip suite
couldn't see the gap: it round-trips the writer through the reader, so a
relation the writer never emitted couldn't appear as a mismatch there.
