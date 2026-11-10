---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

Budget parallel geometry workers by the memory of the whole tab. Every wasm instance (the pre-pass worker and each geometry worker) holds a full copy of the source, so the tab peak grows with workers × file size; the worker count is now the cores tier lowered to the largest count whose estimated tab peak (`300 MiB + 4.36·F + (N+1)·(100 MiB + 0.86·F)`, fitted to six measured cold loads within ±1.3 %) fits 75 % of `navigator.deviceMemory` (at least 1 GiB headroom). Counts that already fit are unchanged; large files get fewer workers instead of exhausting the tab, never fewer than one. Up to 512 MiB the budget keeps two workers whenever they fit the whole device: on real mid-size models the peak comes after geometry and does not shrink with fewer workers, while one worker can more than double the load time.

New, opt-in for the host: `assertGeometryMemoryFits(byteLength, workerCountOverride?)` throws `GeometryMemoryBudgetError` when even one worker's estimate exceeds the most memory the device can have; `processParallel`/`processAdaptive` never throw for this and still run one worker (only when `deviceMemory` proves an upper bound; absent or possibly clamped values never refuse). `WorkerCountResult` gains `estimatedPeakMiB`, `budgetMiB`, `fitsBudget`, `exceedsDevice`, `minimumPeakMiB` and `deviceCeilingMiB`, and `reason` can be `'override'`.

**Behaviour change:** an explicit `workerCountOverride` (the viewer's `?geomWorkers=N`) now wins over the 75 % budget and skips the refusal. It is still clamped to the job count, `maxWorkers`, and the most workers whose estimate fits the whole device memory (never below one), so a sticky override cannot plan past the machine. `?perf.geomMemoryGB=N` (or `__IFC_LITE_GEOM_MEMORY_GB`) plans as if the device had exactly N GiB, for reproducing a low-memory machine.

The viewer refuses such a load before reading the file, with its own message in every shipped locale ("This model needs about … of memory to load in the browser, more than this device or browser can provide …"), distinct from the 2 GiB source limit and from the generic out-of-memory error; `.ifczip` sources are checked after unwrapping.
