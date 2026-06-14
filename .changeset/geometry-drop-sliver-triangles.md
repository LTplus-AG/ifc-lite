---
"@ifc-lite/geometry": patch
"@ifc-lite/wasm": patch
---

Drop sub-grid sliver triangles so faceted geometry stops rendering spikes

After the pure-Rust CSG kernel replaced Manifold (#1024), the pipeline no longer
cleaned the degenerate output Manifold used to remove on import. Faceted breps,
extrusion-profile walls and walls with openings could therefore render visible
needle "spikes" and jagged silhouettes coming from zero-area / collinear sliver
triangles (other viewers don't show them because they clean degenerates on import).

`Mesh::clean_degenerate` now drops triangles whose perpendicular height is below the
kernel's reconcile grid (1/65536 m ≈ 15.3 µm) — sub-resolution coincident-pair and
collinear slivers that carry no area. It runs at every mesh-output chokepoint
(per element, per sub-mesh, and on the void-cut output), so both wasm (viewer) and
native (server) get identical output. Vertices and normals are left untouched, so
flat shading / sharp creases are preserved and the result is bit-deterministic. On a
large faceted-brep building this removes 100% of the genuine degenerate slivers for a
~1% triangle reduction with no performance cost.
