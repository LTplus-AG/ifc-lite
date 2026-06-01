---
"@ifc-lite/mcp": minor
---

Wire `geometry_get` and `raycast` to real headless tessellation.

Both tools previously returned `UNSUPPORTED_OPERATION` and pushed agents toward
`geometry_bbox`, so anything that needed actual mesh geometry silently degraded
to quantity-derived bounding boxes. Now that `@ifc-lite/geometry` tessellates in
the MCP server's Node process, they answer from real triangles:

- `geometry_get` returns the selection's tessellated mesh — `format="json"`
  (positions/normals/indices, capped by a vertex budget) or `format="gltf"`
  (a base64 GLB of the selection via `GLTFExporter`).
- `raycast` returns the nearest entity hit (expressId, globalId, ifcType,
  distance, point) via a triangle-exact cast.

Both run off a single shared tessellation cache (new `tools/mesh.ts`) that clash
detection now also uses, so clash, `geometry_get`, and `raycast` mesh each model
once. Mesh coordinates are reported in the tessellation frame (`coordinateInfo`
is echoed) and `raycast` operates in that same frame so the two compose.
