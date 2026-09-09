---
"@ifc-lite/collab": minor
---

Add `MergeReport.droppedDeletions` so a caller of `mergeBranch(parent, branch, 'layer')` can detect when a branch-side deletion did not propagate to the parent — a documented limitation of the IFCX snapshot wire format, which cannot distinguish "removed" from "no opinion". Pin the deletion-drop behaviour itself with a regression test in `test/branch-merge-layer-overlay.test.ts`.
