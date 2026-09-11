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

A CodeRabbit finding then caught an unguarded append of the same shape in
the `IfcWorkPlan` -> `IfcWorkSchedule` `IfcRelNests` pass (two distinct
`IfcRelNests` entities nesting the same pair duplicated the edge); fixed
with the same `includes()` guard the `IfcRelAssignsToControl` pass's
grouping half already used. A sweep for the same shape elsewhere in this
file found two more unguarded identity-list appends and fixed both: the
task/subtask `IfcRelNests` hierarchy (`childGlobalIds`), and
`IfcRelAssignsToControl`'s task-mapping half (`taskGlobalIds` /
`controllingScheduleGlobalIds`, guarded together on one predicate so the
paired arrays stay in lockstep). `IfcRelAssignsToProcess`'s
`productExpressIds` / `productGlobalIds` append was deliberately left
unguarded: that relation carries a `QuantityInProcess` attribute, so the
same product can legitimately repeat across relations to the same task as
separate quantity assignments — it is a multiset, not an identity set, and
guarding it would silently drop real data.
