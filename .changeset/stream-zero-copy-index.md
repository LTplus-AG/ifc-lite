---
"@ifc-lite/geometry": patch
---

Cold-load main-thread work reduction in the parallel geometry stream: the sharded pre-pass now stitches the entity-index columns directly into exact-size SharedArrayBuffer-backed storage (two-phase stitch), so index delivery to the geometry workers, the parser worker, and the sharded pre-pass is zero-copy instead of three full-column copies on the critical path that gates job dispatch. The worker batch handler also stops re-allocating a wrapper object per mesh (~110k per large load) and passes the structured-clone mesh objects straight through. Render parity is exact (verified mesh-count identical on 177MB and 883MB models).
