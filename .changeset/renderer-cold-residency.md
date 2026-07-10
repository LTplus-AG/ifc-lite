---
"@ifc-lite/renderer": minor
---

Opt-in cold (evict-to-disk) residency tier (issue #1682, phase 3b).

Three tiers: hot (GPU+CPU) / warm (CPU only, GPU evicted) / cold (metadata shell only, geometry restorable from a `ColdGeometryProvider` — the viewer wires the v13 cache entry with `Blob.slice` partial reads). `Scene.setHostResidencyBudget(bytes)` demotes warm buckets to cold LRU-first; eligibility is strict (pristine only — recoloured/moved/removed buckets are dirty; overflow "#N" sub-buckets excluded; provider present). Cold buckets are sealed (new arrivals route to a fresh sub-bucket), carried through finalize re-grouping as shells, and restored asynchronously on demand. `Scene.getResidentCpuBytes()` reports bucket CPU bytes. Off by default.
