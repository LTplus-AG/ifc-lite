---
"@ifc-lite/wasm": minor
---

Add the opt-in global instance plan entry points: `setGlobalInstancePlan`, `addGlobalKeyPlan` and `setGlobalKeyPlanning`. With a plan installed, `processGeometryBatchPartitioned*` decides GPU instancing from model-wide facts instead of per-batch repetition. Those facts are mapped sources at or above the gate, and repeated content keys the streaming pre-pass planned. The partition appends an `IFNL` key trailer to the IFNS shard; readers that predate it ignore it. Meshing is unchanged under a plan, so flat meshes and geometry fingerprints equal the unplanned batch's. With nothing installed, output is byte-identical to before. The prepass columns event now also carries `mappedInstanceCounts`.
