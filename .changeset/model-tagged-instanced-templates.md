---
'@ifc-lite/renderer': minor
---

Model-tagged instanced-template storage in `Scene`. `InstancedTemplateGPU` now carries a `modelIndex`, `addInstancedShard(device, shard, modelIndex = 0)` takes the owning model, and the new `removeInstancedTemplatesForModel(modelIndex)` frees exactly that model's GPU buffers and occurrences. Template slots are stable — a removal blanks its slots instead of splicing, so no other model's `templateIndex` shifts — and `getInstancedModelIndices()` reports which models hold templates. `getResidentGpuBytes()` counts live templates only.

Also fixes a latent slot misalignment: after `releaseGeometryData()` a subsequently uploaded shard's CPU template landed at CPU index 0 instead of its GPU slot, so CPU consumers (raycast / measure / section / export) could read a different template's triangles than the occurrence named.

Behaviour is unchanged for existing callers (`modelIndex` defaults to 0 and the single `addInstancedShard` call site does not pass one).
