---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
"@ifc-lite/export": patch
"@ifc-lite/cli": patch
---

Weld per-face-duplicated faceted-brep vertices at the mesh SOURCE instead of per export. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicates every shared corner once per incident face (~3-6x). That collapse now happens once, at the single per-element mesh funnel (`build_mesh_data` in `produce_element_meshes`), so every element -- render, GLB/OBJ export, and analysis -- arrives welded in its `MeshData`, and the previously separate per-export welds (from-bytes `to_yup` and the viewer's from-meshes GLB path) are removed as redundant. The weld keys on the exact position plus a quantized normal, so creases (a cube corner shared by three faces with distinct normals) stay split and flat/crease shading is preserved; world triangles, winding, and the world AABB are unchanged. It is deterministic and byte-identical cross-arch (native == wasm32, positions and topology identical, only the documented libm-trig normals differ), and closes the volume/watertightness gap for non-voided faceted breps on the render path (voided elements already welded via the coplanar-facet pass). The mesh-output determinism manifests are re-pinned for the one affected battery element (the round column #500, an extruded circular profile: 216 -> 144 vertices, triangle count unchanged).
