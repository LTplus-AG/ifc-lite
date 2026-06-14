---
"@ifc-lite/geometry": patch
---

Stop boolean-heavy models still hanging at 95% after the per-boolean escalation budget (#1109 follow-up).

The deterministic per-boolean budget (#1112) bounded a *single* boolean, but two holes kept dense models stalling past the geometry-stream watchdog:

- **Overshoot.** The budget's `tripped()` check only fired at arrangement loop boundaries — once per triangle in the seam retriangulation. A single heavily-fragmented host face (a slab cut by 24-47 openings) inserts thousands of constraint points in *one* `triangulate` call, so a boolean ran to **7.7M** escalations — ~4 minutes — between two checks before bailing. Profiled on a real model: one IFCSLAB took 243 s.
- **Distributed cost.** An element with many openings runs one boolean *per* opening, each well under the per-boolean cap, so none trips — yet the element's total exact work is huge and the geometry batch blows the stream watchdog.

This adds a **per-element** escalation budget alongside the per-boolean one. `kernel::budget::begin_element()` (called once per element at the unified `produce_element_meshes` entry — native *and* wasm) accumulates escalations across every boolean the element issues; when the element total crosses `DEFAULT_ELEMENT_CAP = 100_000` it degrades as a whole (remaining cuts bail to the #635 AABB box-cut), instead of grinding. The kernel's per-point retriangulation and constraint-recovery loops now also check the budget, so a single boolean can no longer overshoot the cap by 15×.

Still a **deterministic count**, accumulated in deterministic per-opening order on the element's single worker thread (the kernel has no internal rayon), so native and wasm degrade the *same* element identically — the cross-target parity the kernel exists to guarantee is preserved. Calibrated against the model corpus: healthy per-element totals are p99 ≈ 13k escalations, so the 100k cap (~8× p99) never false-trips a legitimate cut. The cap engages only when an element scope is opened (the batch path); direct kernel/router callers, the server, and offline export stay unbounded via the existing `set_cap(None)` / `IFC_LITE_CSG_BUDGET=0` switch — so the pinned determinism manifests are unchanged.

Measured on the profiling corpus (one boolean-heavy structural model): the worst element drops from 243 s to 2.9 s, and total serial geometry from minutes to ~28 s.
