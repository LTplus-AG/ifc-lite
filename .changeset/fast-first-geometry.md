---
"@ifc-lite/geometry": patch
---

Cut time-to-first-geometry roughly in half on large models by reordering the streaming pre-pass.

Content-affinity routing had deferred all job emission to the very end of the pre-pass — the per-job geometry-hash pass, plus the entity-index event being emitted last, left the geometry workers idle until the whole pre-pass finished. The pre-pass now ships the events workers gate on (entity-index + styles) and a small first job wave right after the scan, then runs affinity routing over the rest. On a ~50k-part model first-visible-geometry dropped from ~22s to ~12s with no change to total load time or geometry — the bulk keeps exact geometry-hash affinity; only the small first wave routes by element id.
