---
"@ifc-lite/parser": minor
---

Add IFC 4D / construction scheduling extractor (`extractScheduleOnDemand`).
Parses `IfcTask`, `IfcTaskTime`, `IfcRelSequence`, `IfcRelAssignsToProcess`,
`IfcRelAssignsToControl`, `IfcRelNests`, `IfcWorkSchedule`, `IfcWorkPlan`, and
`IfcLagTime` from the source buffer and returns a normalized
`ScheduleExtraction` — hierarchy, assigned products, typed dependency edges
(FS/SS/FF/SF with `IfcLagTime` resolved to seconds), and work-schedule
grouping — that UIs can drive a Gantt view and 4D animation from.
