---
"@ifc-lite/parser": patch
---

Fix a crash in `serializeScheduleToStep` when exporting a `WorkScheduleInfo`
built without `childScheduleGlobalIds` — the field the `IfcWorkPlan` ->
`IfcWorkSchedule` `IfcRelNests` grouping fix added. The viewer's standalone
`IfcWorkPlan` builder (`buildWorkPlanInfo` in `apps/viewer`) constructs a
`WorkScheduleInfo` with `kind: 'WorkPlan'` and no `childScheduleGlobalIds`,
which threw `TypeError: Cannot read properties of undefined (reading
'length')` on export.

`childScheduleGlobalIds` is now optional on `WorkScheduleInfo`; the
serializer treats an absent field the same as an empty array (both mean "no
nested schedules to write"), so a producer that has no opinion on
`IfcRelNests` grouping doesn't have to populate it.
