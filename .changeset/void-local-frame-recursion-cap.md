---
'@ifc-lite/geometry': patch
---

Fix a WASM trap ("memory access out of bounds") when subtracting three or more `IfcVoidingFeature` voids with conflicting rotation axes from one host.

`try_cut_wall_local_frame` rotates a plan-rotated wall into its own axis-aligned frame and recurses into `apply_void_context_inner` to run the exact cut there. Its doc comment claimed the recursion was self-limiting because "in the frame every opening's depth is +Z" — true only when every opening reclassifies as frame-aligned. An opening that stays `NonRectangular` keeps its own depth direction re-expressed in the new frame, and that direction can itself be non-axis-aligned, so `try_cut_wall_local_frame` fires again and seeds a second frame from a different opening. With enough openings disagreeing on rotation axis this recurses without bound: a Rust stack overflow natively, and in WASM (no stack guard page — the overrun runs into linear memory instead) the reported `RuntimeError: memory access out of bounds`, which corrupts the module so every later operation traps too.

`apply_void_context_inner` now takes an explicit `allow_local_frame` flag, `true` only on the outer call and forced `false` on the recursive call `try_cut_wall_local_frame` makes — capping the local-frame rotation at one per host. A later, differently-oriented opening still gets subtracted, just via the same exact/world-path kernel `NonRectangular` openings already use, instead of a second rotation.
