---
"@ifc-lite/geometry": patch
---

Large IFC files (512 MiB and up) no longer have their peak memory before geometry inflated by the pre-pass overlapping the geometry workers (#10264). On those loads the geometry workers receive their setup and first jobs only after the pre-pass has finished and its worker has been terminated, so its heap no longer coexists with their source copies and entity index. The sharded entity-index scan is skipped on those loads for the same reason. Geometry output is unchanged. Smaller files keep the current path, and the worker-count planner now accounts for the pre-pass worker that still runs alongside the pool there.
