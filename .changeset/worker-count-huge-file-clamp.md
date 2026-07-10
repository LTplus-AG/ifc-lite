---
"@ifc-lite/geometry": patch
---

Clamp the 16-core worker tier for huge files (issue #1682). The `cores >= 16` tier was the only one without the `>512MB` file-size clamp, so a 16-core desktop spawned `cores/2 = 8` geometry workers on an 883MB model - each a private wasm realm holding a full source copy plus its own entity index (~1.3GB per worker, ~10.6GB total), producing 16GB memory peaks. Huge-file geometry is memory-bandwidth bound (a 5th/6th worker gives no measured speedup), so the tier now caps at 4 workers above 512MB, matching the 12-core tier. `?geomWorkers=N` still overrides per host.
