---
"@ifc-lite/geometry": minor
---

Fix the exact CSG kernel hanging at 95% on boolean-heavy models (issue #1109), without sacrificing the cross-target determinism the kernel exists to guarantee.

The pure-Rust exact kernel (#1024) replaced Manifold + the legacy BSP port with one bit-deterministic kernel — the right call for server↔client parity (clients run a native Rust server *and* the wasm viewer and need matching results). But the flip dropped Manifold's/BSP's operand cap, so a boolean-heavy model (Tekla half-space end-clips, Revit flush openings — full of near-coplanar faces) drives the exact predicate cascade off its interval filter on a huge fraction of predicates, climbing the fixed-width rungs (to ~1340 bits) and into BigRational with no safety valve. The geometry stream never finishes; the loader stalls at 95%.

This adds a **deterministic** per-boolean budget: it counts interval-filter failures (every predicate that needs the expensive exact tier) and, when the count crosses a cap, bails the boolean to the un-cut host so the existing #635 AABB box-cut fallback fires. The count is a pure function of the snap-grid operands, so the trip point is identical on native x86_64/aarch64 and wasm32 — the server and the browser degrade the *same* hard element to the *same* fallback. A wall-clock budget would have broken parity (fast native finishes the exact cut while slow wasm trips), so the metric is deliberately platform-independent.

The cap (`budget::DEFAULT_CAP = 500_000`) is calibrated 33× above the worst healthy boolean measured across the model corpus (~15k exact evaluations), so it never false-trips a legitimate cut; healthy models are byte-identical (determinism manifests unchanged). `budget::set_cap(None)` (or `IFC_LITE_CSG_BUDGET=0`) lifts it for the server/offline-export profile where "exact but slow" is acceptable — one code path, two profiles, no kernel fork.
