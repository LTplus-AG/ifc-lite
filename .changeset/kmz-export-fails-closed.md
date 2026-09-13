---
"@ifc-lite/wasm": patch
---

`exportKmzFromMeshes` now throws (`NO_RENDER_GEOMETRY`) when no triangle survives, instead of returning a small archive around a COLLADA document the 1.4.1 schema rejects, and throws `MALFORMED_MESH_INPUT` when a declared vertex or index count runs past its buffer, where it previously shipped the archive with every later mesh missing. `exportGlbFromMeshes` now refuses an index whose value is at or past its own mesh's vertex count (`MALFORMED_MESH_INPUT`), where it previously wrote the out-of-range value into the GLB and reported success.
