---
"@ifc-lite/ids-authoring": minor
---

Comment threads in the sidecar: new ops `meta.comment.add`, `meta.comment.reply`, `meta.comment.resolve`, `meta.comment.removeThread` and their inverses `meta.comment.removeReply` / `meta.comment.restoreThread` (sidecar only, undoable, gate-checked). Threads outlive the node they are anchored on. `commentThreads` / `extractMentions` form the view model (anchors, orphan flag, participants, `@name` mentions, unresolved badges). `mergeDocuments` merges comment threads additively.
