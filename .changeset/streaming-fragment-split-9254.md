---
"@ifc-lite/renderer": patch
---

While a model streams, overridden glass shows its override colour at once again, and X-Ray fades only the entities it names instead of every same-colour neighbour streamed in with them. A streaming fragment now passes `canPartitionBatch` when it has its own piece list and holds no colour-merged mesh, so it splits by override promotion and by X-Ray alpha the way a finished batch does. Each fragment cuts its subsets from its own pieces, so a mesh split across fragments is still drawn once. Fragments of an ephemeral stream, and fragments streamed in while a scene snapshot hydrates, still draw whole. The GPU and host residency budgets now also wait out a time-sliced finalize, so they no longer evict a bucket batch that is built but not yet shown, or drop its meshes while the old fragments still draw from them.
