---
"@ifc-lite/renderer": patch
---

Add the WebGPU GPU-instancing draw path: a `vs_instanced` shader entry + parallel
instanced pipeline (template vertex buffer at slot 0, per-occurrence buffer at
slot 1 carrying mat4 + entityId + rgba) drawn as `drawIndexed(indexCount,
instanceCount)`, plus `Scene.addInstancedShard` to upload a decoded IFNS shard.
The fragment shader now reads a `color` interstage varying (equivalent to the
prior `uniforms.baseColor` for the flat path; per-occurrence for the instanced
path). The pass is additive and **inert until a shard is fed** (no templates ⇒ no
draws ⇒ the flat path is byte-identical), so nothing renders through it yet — the
worker→main shard plumbing is a follow-up.
