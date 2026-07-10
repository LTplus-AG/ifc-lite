---
"@ifc-lite/renderer": minor
---

Opt-in GPU residency budget (issue #1682, phase 3a of the chunked-residency plan).

`Scene.setGpuResidencyBudget(bytes)` evicts least-recently-drawn bucket batches (GPU buffers destroyed, CPU meshData + metadata shell kept) once their combined bytes exceed the budget, and rebuilds them on demand when the draw loop wants them again (`requestBatchResidency` + time-budgeted `processResidencyRestores`). Never evicts batches drawn this frame or idle fewer than 30 rendered frames; no-ops during streaming, in ephemeral mode, or after geometry release. `FrameStats` gains `batchesNotResident`. Off by default; pairs with spatial chunk bucketing.
