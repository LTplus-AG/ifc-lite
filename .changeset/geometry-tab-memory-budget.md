---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

Budget parallel geometry workers by the memory of the whole tab. Every wasm instance (the pre-pass worker and each geometry worker) holds a full copy of the source, so the tab peak grows with workers × file size. The worker count is now the cores tier lowered to the largest count whose conservative estimate fits 75 % of `navigator.deviceMemory` (at least 1 GiB headroom), never fewer than one. The estimate is `300 MiB + 4.36·F + (N+1)·(170 MiB + 0.86·F)`, an upper envelope of 13 measured cold loads, synthetic and real. Up to 512 MiB the budget keeps two workers whenever they fit the whole device, because on real mid-size models the peak comes after geometry and does not shrink with fewer workers. Counts that already fit are unchanged.

New, opt-in for the host: `assertGeometryMemoryFits(byteLength)` throws `GeometryMemoryBudgetError` only when even the full source copies the chosen path must hold exceed the most memory the `deviceMemory` reading allows. That is 3 × source for the worker pool and 2 × for the serial fallback. Absent or possibly clamped readings (8, 32) never refuse. `processParallel` / `processAdaptive` never throw for this.

`computeWorkerCount` now returns `WorkerCountPlan`, which extends the unchanged `WorkerCountResult` with the memory plan. `WorkerCountInputs` gains optional `deviceMemoryCeilingGB` and `planningMemoryCapGB`. `workerCountOverride` also accepts `{ count, beyondBudget: true }`: a plain number is still clipped by the memory budget as before, while the object form may use the budget's headroom but never more than the whole device. `?perf.geomMemoryGB=N` (or `__IFC_LITE_GEOM_MEMORY_GB`) caps the planning memory to reproduce a small device. It can only lower the worker count, never refuse a load.

In the viewer, a load that exceeds the floor is refused before the file is read, with its own message in every shipped locale. Retry tries the same file anyway. `.ifczip` sources are checked after unwrapping. Only `?geomWorkers=N` in the current page URL is a beyond-budget request; a remembered value keeps the budget-clipped meaning.
