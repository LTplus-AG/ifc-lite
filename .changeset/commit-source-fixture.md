---
'@ifc-lite/source-fixture': minor
---

Teach the fixture provider the commit-aware contract and add `runCommitConformanceSuite`.

A fixture world can declare models with commit chains, identity records and per-element fingerprints; the fixture derives artifact digests, per-commit change counts, stored diffs and element history from them rather than letting a test state them separately — so a fixture cannot describe a diff its own fingerprints contradict. The new suite checks capability/method agreement, commit ordering and immutability, payload digests, fingerprint sampling, diff/count consistency, element history across a re-GUID, and the `conflict` + idempotency contract on `createCommit`.
