---
'@ifc-lite/clash': minor
'@ifc-lite/viewer': minor
---

Re-export `triangleArea` and the `Triangle` type from `@ifc-lite/clash`'s public surface (issue #2199: "mesh analysis reachable from TypeScript"). It previously existed only inside the package's clash contact solver, so nothing outside `@ifc-lite/clash` — including the viewer's Measure tool — could reach a triangulated-mesh area even though every `MeshData` already carries the `positions`/`indices` a caller needs.

The Measure tool's Quantities panel (#2199 §1, element surface area) now reports a "mesh" area alongside the existing declared (net/gross/unqualified) and mesh volume rows: the selection's total triangulated surface area, summed live from mesh geometry via the newly-exported `triangleArea`. Unlike the mesh volume row, this needs no closed-solid proof, so it covers open shells and layered walls too — and unlike the mesh volume row, it is not invalidated by federation alignment re-baking, because it is recomputed from current vertex positions rather than read from a value cached before alignment ran. It is the sum of every meshed face (not one side), so it is labelled "mesh" and never presented as a `NetSideArea`/`GrossSideArea` equivalent. Where no mesh geometry exists for a selected element (e.g. an instanced-only occurrence with no flat mesh materialised), the panel says so rather than reporting zero.
