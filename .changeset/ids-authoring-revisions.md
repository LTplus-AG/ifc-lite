---
"@ifc-lite/ids-authoring": minor
---

Revisions with sign-off and a hash chain: `createRevisionLog`, `commitRevision`, `signOff`, `checkoutRevision` and `verifyRevisionLog`. Each revision's SHA-256 hash covers its record and its parent's hash; the content hash covers the normative content; sign-offs are chained too, so any edit of a stored log is reported. Released revisions are read-only (later edits start a draft). `revisionTimeline` is the view model for a revision list.
