---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

Add the opt-in global instance plan (`?perf.globalInstancing=1`, off by default). With the flag on, the worker pool asks the pre-pass to plan repeated geometry once per model and arms each worker with that plan, re-arming it after an engine rebuild. The instanced-shard decoder reads the `IFNL` key trailer (`DecodedInstancedShard.templateKeys`). The renderer joins records that share a key into one growable template per model, so each repeated geometry is one template and one draw. A keyed slot only opens while its model sits at the identity pose. It is sealed to an ordinary template before the model moves or the device is recovered; later records of that model upload per shard as before. With the flag off nothing changes.
