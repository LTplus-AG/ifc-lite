---
'@ifc-lite/plugin-api': minor
'@ifc-lite/source-fixture': minor
---

Let a commit-aware provider declare the digest algorithm it actually has, and add `capabilities.commits.modelIdsAreFileIds`.

`CommitArtifact.digest` is now documented as `<algorithm>:<value>`, matching `ModelIdentity.hash` in `@ifc-lite/diff` rather than being narrower than it. `sha256:` stays strongly preferred and is the only form a host can independently verify; another algorithm is allowed because some stores expose only their own content hash, and relabelling one as SHA-256 is a claim nobody checked. `runCommitConformanceSuite` verifies the bytes when the algorithm is `sha256` and otherwise checks shape, stability and that two commits never share a digest.

`modelIdsAreFileIds` tells a host that a model's id is the id of the file backing it, so a model loaded through the ordinary file browser can still find its history — without it a file-backed commit store's History panel stays empty for every model a user opens the normal way.

The suite's `accept`-ordering check no longer assumes a provider can serve every declared format for every commit: `payloadFormats` is what a store can serve across its contents, and a store that keeps the uploaded bytes transcodes nothing. It now discovers the servable set per commit and asserts the ordering rule only where the provider actually has a choice.
