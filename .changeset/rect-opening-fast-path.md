---
"@ifc-lite/geometry": patch
---

Add an analytic fast path for rectangular openings, skipping the exact CSG kernel
for the common case.

The pure-Rust exact CSG kernel is at its single-threaded, memory-bandwidth-bound
floor (it won't parallelise — adding geometry workers gives no speedup), and
void-cutting is ~85-90% of load. The only remaining lever is doing *less* exact
CSG. `rect_fast` cuts axis-aligned rectangular openings through an axis-aligned
box host (the dominant case: windows/doors in a straight wall) with a 3D cellular
decomposition instead of the mesh-arrangement kernel: split the host box by every
opening plane on all three axes, mark each cell solid/void, and emit the exposed
faces. Watertight by construction (shared snapped grid vertices on the kernel's
own `SNAP_GRID`), deterministic (FMA-free f64 → byte-identical native==wasm), and
handles windows, doors (flush to an edge), recesses, notches, and overlapping
openings uniformly.

It is a pure optimization: any case it can't prove safe — non-box host (multi-
layer / chamfered / diagonal walls), non-rectangular opening, or a near-edge
feature whose grid lines would collapse at the host's f32 magnitude — defers to
the exact kernel unchanged. `IFC_LITE_RECT_FAST=0` forces everything back to the
exact path.

Measured (dental_clinic, a box-wall-dominated building): ~94% of openings cut
analytically, void-cut geometry time ~0.95 s → ~0.32 s (~3×), with 2% *fewer*
triangles (no bloat). Models with more multi-layer or diagonal walls fire less
(those correctly defer).
