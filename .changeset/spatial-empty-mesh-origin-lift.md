---
'@ifc-lite/spatial': patch
---

Fix the spatial index placing an empty mesh with a non-zero origin at world `[0,0,0]` instead of its own origin.

`computeMeshBounds` returned early for `positions.length === 0` before the origin lift ran, so an empty mesh (a mesh with geometry stripped, e.g. a fully-clipped or degenerate element) with `mesh.origin` set was indexed at world `[0,0,0]` regardless of where it actually sits. Every other mesh — including a populated one with the same origin — was correctly lifted by `mesh.origin` before being indexed. Reproduced directly: an empty mesh with `origin: [500, 500, 500]` was found by a query box at `[0,0,0]` and missed by a query box at `[500, 500, 500]`.

The origin extraction is now hoisted above the early return so there is a single place that reads `mesh.origin`, and the empty-mesh path returns a degenerate box at `[ox, oy, oz]` instead of `[0, 0, 0]`. This only changes behaviour for empty meshes that also carry a non-zero `mesh.origin`; the common case (no origin, or a populated mesh) is unaffected.
