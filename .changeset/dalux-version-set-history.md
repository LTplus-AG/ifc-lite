---
'@ifc-lite/source-dalux': minor
---

Expose Dalux version sets as commit history (contract 2.1.0), so the viewer's History panel works for Dalux models.

Dalux has no endpoint listing a file's revisions, which is why `revisionHistory` is `false`. Version sets are the way in: each pins one revision of every file in a file area and reports that revision's own id, hash, author and timestamp, so sweeping a project's sets reconstructs every model's history — and `/revisions/{r}/content` downloads any of them.

A commit is a *revision*, not a version set: two sets pinning the same revision collapse into one commit carrying both set names, because the model did not change between them. Ordering prefers Dalux's own revision number over timestamps, so the timeline survives Dalux answering with a file's current metadata. `artifact.digest` is `dalux-content:<contentHash>` and deliberately not relabelled `sha256:`: measured against a live tenant, `contentHash` is a 256-bit hash in base64url with the file extension appended, not the hex the contract's preferred form expects, and the algorithm is unverified. It is also a content hash, so identical bytes share one under a new revision id.

Ordering prefers `File.version` over timestamps because Dalux's `lastModified` carries no time — every revision uploaded on one day ties, which on a live project is the normal case.

The manifest now requires `^2.1.0`: a 2.0.0 host would register the provider and then never call a commit method, leaving the panel empty with no explanation.
