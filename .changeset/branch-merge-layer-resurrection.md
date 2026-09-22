---
"@ifc-lite/collab": minor
---

Fix `mergeBranch(..., 'layer')` recreating an entity the parent deleted after the fork, through ordinary live editing, whenever the branch's snapshot still carried that path because the branch never touched it. The tombstone registry `applyIfcxOverlay` relies on is only ever populated by prior `applyIfcxOverlay` calls, so a plain `deleteEntity` on the parent never reached it; the merge saw a path the parent doc lacked and created it.

Also stop `MergeReport.droppedDeletions` reporting a confident `0` when it cannot actually be computed. The count depends on the branch's fork-time entity snapshot, keyed by `branch.session.doc`'s object identity; a branch session rebuilt around a different `Y.Doc` with equivalent content (a reload, a second tab, a server-side merge job) has no entry. `droppedDeletions` is now `number | null`, with `null` meaning "unknown" instead of a possibly-wrong zero.
