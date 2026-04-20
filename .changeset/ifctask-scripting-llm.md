---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/cli": minor
---

Add IFC scheduling entity support across the scripting SDK, LLM assistant, and
CLI headless backend.

**Create API** — `IfcCreator` gains `addIfcWorkSchedule`, `addIfcWorkPlan`,
`addIfcTask` (with inline `IfcTaskTime`), `addIfcRelSequence` (with
`IfcLagTime`), `assignTasksToWorkSchedule` (`IfcRelAssignsToControl`),
`assignProductsToTask` (`IfcRelAssignsToProcess`), and `nestTasks`
(`IfcRelNests`).

**SDK** — new `bim.schedule` read namespace (`data()`, `tasks()`,
`workSchedules()`, `sequences()`) backed by the parser's
`extractScheduleOnDemand`. New `ScheduleBackendMethods` is now part of
`BimBackend`; the viewer's `LocalBackend`, the `RemoteBackend` proxy, and the
CLI `HeadlessBackend` all implement it.

**Sandbox** — new `bim.schedule.*` QuickJS namespace plus schedule methods on
`bim.create.*`, all carrying LLM semantic contracts so the auto-generated
system prompt teaches the assistant when to use them. Autocomplete types
(`bim-globals.d.ts`) regenerated.
