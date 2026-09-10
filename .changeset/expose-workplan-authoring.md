---
"@ifc-lite/viewer": patch
---

The Generate schedule dialog's Advanced panel can now add a standalone
`IfcWorkPlan` container alongside the generated `IfcWorkSchedule`
(`schedule-utils.ts`'s new `buildWorkPlanInfo`). Previously `IfcWorkPlan` was
parsed, serialized, and scriptable via `bim.author.addIfcWorkPlan`, but the
schedule authoring UI had no way to create one.

The plan is intentionally standalone, not grouped with the schedule: neither
relation the schema allows for that grouping round-trips today.
`schedule-extractor.ts`'s `IfcRelAssignsToControl` pass only resolves
`RelatedObjects` through the task table, so a schedule assigned to a plan
that way is silently dropped on read (the same blindness the existing
`assignSchedulesToWorkPlan` SDK helper would hit); a parallel `IfcRelNests`
gap is tracked separately (#4329/#4330). Shipping a UI that produces a
grouping relation whose read path drops it would be worse than the missing
feature, so this PR emits the plan with no `taskGlobalIds` and no relation
at all.

`GanttToolbar`'s schedule filter dropdown now excludes `kind === 'WorkPlan'`
entries — one never directly controls a task, so listing it as a filter
option would always resolve to zero rows.
