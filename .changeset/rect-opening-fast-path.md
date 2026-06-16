---
"@ifc-lite/geometry": patch
---

Add an f64 through-box fast path for rectangular openings — the overwhelmingly common void (a window/door box cut transversally through a slab-like wall) — bypassing the exact CSG arrangement entirely (~100–3000× cheaper per cut) while staying byte-identical native==wasm.

The Phase-1 planar clip only handles a cutter that acts as a single half-space; a rectangular through-opening straddles the host on four lateral faces, so it still routed through the exact kernel. `ClippingProcessor::subtract_box_fast` now subtracts an axis-aligned box analytically: each host triangle is partitioned by the four lateral planes (a conforming 3×3 cell split, so no T-junctions), the window footprint is dropped, and the four reveal faces are synthesised from the actual cut rim — taking the host's own subdivision points (face diagonals, welds) onto each reveal edge so it matches the rim exactly, including when the host front and back faces are tessellated differently. The void router (`apply_void_context`) tries it per rectangular opening before materialising a penetrating box mesh for the exact subtract.

It is only ever a fast path, never a different answer:

- **transversality gate** — the box must span the host on exactly one axis (the through/thickness axis) and lie strictly interior on the other two; blind pockets, edge/corner cuts and non-transversal boxes defer;
- **coplanar handling** — a host face coplanar with a cutting plane (e.g. two windows sharing a sill height) is sent to one side only, never duplicated;
- **watertightness** — every directed boundary edge must cancel (the result is closed) on the stitch grid, otherwise defer to the exact kernel.

Determinism is by construction: plain FMA-free f64 over the host's own coordinates, fixed plane/triangle/loop iteration order, and the same `Q`-grid edge stitching as the planar clip — only sign and comparison results are consumed, never an epsilon-snapped magnitude. The box and planar fast paths share one gate and the element-level fallback (`f64_fast_path_active`/`note_planar_clip_fired`), so a cut that cracks once scaled/placed into f32 world coordinates is re-processed on the exact kernel, and `IFC_LITE_DISABLE_PLANAR_CLIP=1` (native) forces the exact kernel for both. Validated watertight and volume-equivalent to the exact subtract on synthetic walls (single window, multiple through-axes, sequential disjoint windows including a shared sill, with pockets/corners/no-ops correctly deferring).
