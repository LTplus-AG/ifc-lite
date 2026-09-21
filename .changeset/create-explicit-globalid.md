---
'@ifc-lite/create': minor
'@ifc-lite/sdk': minor
---

In-store element builders (`addWallToStore`, `addColumnToStore`, … and the matching `bim.store.add*` params) accept an explicit `GlobalId`. A re-runnable author such as a flow graph derives it from a stable key so a re-run updates the element instead of duplicating it; relationships keep their own generated GUIDs, and a malformed GlobalId is refused.
