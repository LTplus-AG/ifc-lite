---
"@ifc-lite/collab": patch
---

Fix `sweepBlobs` reporting a blob as reclaimed even when the underlying `store.delete()` call failed.

`sweepBlobs` computed how many deletes actually succeeded but then discarded that count and returned `decision.reclaimBytes` unconditionally — the full byte total `planBlobSweep` had planned to free, regardless of whether any individual `delete()` call reported failure (a remote backend 404, a race with another sweep, a transient error). A caller using the return value for storage-capacity accounting would believe more space was freed than actually was, while the undeleted blob kept consuming storage. `planBlobSweep` now records each dropped hash's byte length on the `SweepDecision`, and `sweepBlobs` sums only the bytes for hashes whose `delete()` actually returned `true`.
