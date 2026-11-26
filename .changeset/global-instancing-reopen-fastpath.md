---
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

The global instance plan (`?perf.globalInstancing=1`) now applies only to sources of at least `GLOBAL_INSTANCING_MIN_BYTES` (10 MiB, the viewer's uncached small-file tier). Smaller files keep the per-batch instancing decision on every path, so the flag no longer turns off the viewer's small-file fast path. The renderer joins keyed instanced records by default, because only the plan writes them. Before, only the viewer's shard drain turned the join on, so a warm reopen that adopted a scene snapshot drew one template per record instead of the cold load's joined templates. Every upload path now draws keyed shards alike. Setting `scene.keyedInstancing.enabled = false` opts out (the viewer does so on an explicit `?perf.globalInstancing=0`), and `Scene.hasKeyedTemplates()` reports whether a model in the scene received keyed shards.
