---
"@ifc-lite/wasm": patch
"@ifc-lite/geometry": patch
"@ifc-lite/export": patch
"@ifc-lite/cli": patch
---

Shrink GLB exports by welding per-face-duplicated vertices. The faceted-brep mesher emits geometry per `IfcFace` with no cross-face vertex sharing, so a closed shell duplicated every shared corner once per incident face (~3-6x) -- the direct cause of the ~8x-larger GLBs seen on structural (faceted-brep-heavy) models versus reference extractors. Exports now collapse vertices that share an identical position and coinciding normal at the single glTF write funnel, then remap indices. World triangles, the world AABB, and flat/crease shading are preserved exactly (creases keep distinct normals and stay split); the weld is deterministic and cross-arch, applies to every GLB path (in-memory, streaming, bounded, and the viewer's from-meshes export), and leaves `process_geometry` output and the mesh-output determinism manifests untouched.
