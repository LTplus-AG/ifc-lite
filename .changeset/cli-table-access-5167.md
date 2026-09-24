---
"@ifc-lite/cli": minor
---

`HeadlessBackend` gains a `tableAccess()` method (entity table + mutation view + string lookup for its one model) and `createHeadlessContext()` now also returns the `backend` it built. Both are additive, wiring `ifc-lite flow run` up to `@ifc-lite/flow-nodes`' `table.joinByKey` `tag`/`property` match strategies (issue #5167 phase 3.2).
