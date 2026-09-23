---
"@ifc-lite/collab": minor
---

Fix `mergeBranch(..., 'layer')` recreating an entity that the parent deleted after the fork. The branch's IFCX snapshot carries every entity the branch still has, including ones it never touched, and the overlay created any of those the parent lacked. `forkSession` now records the parent's Yjs state vector inside the branch doc (`meta` key `branch.forkStateVector`). A layer merge drops a snapshot node whose path the parent no longer has when the branch's copy is the entity it inherited at fork. A branch that deleted and re-created that path after the fork still merges it.

`MergeReport.droppedDeletions` is computed from the same record, so it no longer depends on the branch session still holding the original `Y.Doc` object. Before, a reload, a second tab, or a merge job rebuilding the session reported a confident `0` and also lost the resurrection guard. The type is now `number | null`. `null` means the branch doc has no fork record (it was forked by an earlier version); in that case neither the count nor the parent-deletion guard could be applied. It never means zero.
