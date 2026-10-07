---
"@ifc-lite/flow": minor
---

Reviewed pause/resume for Flow runs (#6923). A node may declare `review: 'required'`; a run stops downstream of its proposal (`NodeStatus` `review` and `paused`, `RunResult.review`) and continues with `RunOptions.resume`, which restores completed nodes (`restored`) without executing them again. Portable review checkpoints in the new `@ifc-lite/flow/checkpoint` entry (`createCheckpoint`, `resumeOutputs`, `checkpointProposal`, `graphDigest`) and their lifecycle: `approveCheckpoint` by proposal digest, `rejectCheckpoint`, `claimCheckpoint` with graph and source digest checks, `finishCheckpoint`, `recoverCheckpoint`, `parseCheckpoint`, and compare-and-swap `updateCheckpoint` over a `CheckpointStore`. `RunResult` gains the required `review` list. `topologicalOrder` and `FlowCycleError` moved to their own module; the package exports are unchanged.
