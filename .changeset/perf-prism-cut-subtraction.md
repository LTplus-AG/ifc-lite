---
"@ifc-lite/wasm": patch
---

perf(geometry): analytic prism (stepped-extrusion) void subtraction on the host mesh

Subtract rectangular and rebated (stepped) prism openings — the dominant expensive void cut on CSG-heavy masonry models — analytically on ANY host mesh (faceted-brep, clipped, multi-item), instead of running the exact mesh-arrangement kernel. The cutter must weld to a closed manifold whose facets are all parallel or perpendicular to one depth axis; its per-slab cross-sections are sliced into a stepped-extrusion stack, then the host triangles are decomposed by a conforming per-triangle CDT constrained by the exact host∩cutter seam segments, and each cutter face's reveal cap is triangulated and classified by ray parity against the host solid. Every cut passes hard self-checks — an f64 volume identity (outside + inside == host, 0 < removed <= cutter volume) and a closed-surface audit stricter than the exact kernel's own output — or the host defers to the exact kernel with its full opening set (residual openings compose through the same recursion contract as the 2D path). On ISSUE_098-class models this takes native geometry from ~3.9 s to ~2.4-2.6 s at 10 threads, past web-ifc, with no per-element verdict regression on the IfcOpenShell correctness harness. Gate `IFC_LITE_PRISM_CUT=0` to force the exact kernel. Default ON on native and wasm.
