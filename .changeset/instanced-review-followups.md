---
"@ifc-lite/geometry": patch
"@ifc-lite/renderer": patch
"@ifc-lite/cache": patch
---

GPU-instancing review follow-ups: reject truncated instanced-shard cache payloads
and instances referencing missing templates; carry geometry-diff hashes for
instanced-only entities so model compare still detects their changes; fix the
raycast BVH to rebuild on a same-count-different-members instanced set and the
instanced-piece dedup key collision; tombstone instanced-only entities on
delete/split; wire instanced occurrences into the CPU enumeration / raycast
paths; reset instancing metadata in Mesh::clear; guard verify_recomposition
against vertex-count mismatches; validate the transparent-instanced pipeline via
a GPU error scope.
