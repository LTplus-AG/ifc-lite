---
"@ifc-lite/cache": patch
---

Fix GLB re-import: SharedArrayBuffer crash + georeferenced precision corruption.

Two independent round-trip bugs in the GLB importer (`parseGLB` / `parseGLBToMeshData`):

1. **SharedArrayBuffer decode crash.** The viewer streams large imports (>= 256 MB)
   into a `SharedArrayBuffer` (`acquireFileBuffer`), and that buffer reaches the GLB
   parser unchanged. `parseGLB` decoded the JSON chunk with `new TextDecoder().decode(view)`,
   which browsers reject for any SharedArrayBuffer-backed view (a Spectre mitigation) with
   "TextDecoder.decode: ... can't be a SharedArrayBuffer ...". Re-importing a large exported
   GLB therefore threw before any geometry was read. The JSON chunk now goes through
   `safeUtf8Decode` (already in `@ifc-lite/data`), which copies it into a private non-shared
   buffer on the SAB path. Only the small JSON chunk is copied; the binary chunk stays
   zero-copy (it was already copied via `.slice()`).

2. **Georeferenced f32 re-snap.** The exporter keeps vertices relative to the model
   scene-centre and carries the placement on a single root-node translation, precisely so a
   georeferenced offset (a root translation of ~1e6 m) stays out of the f32 vertex buffer. The
   importer was baking that translation back into the f32 vertices, which re-snaps every vertex
   to a ~0.06-0.5 m grid at georef scale and collapses fine (rebar-scale) detail. It now surfaces
   the composed root translation as `MeshData.origin` (world = origin + position) instead, which
   the renderer and every world-space consumer already fold (the local-frame path). The
   non-georeferenced case (zero translation) is unchanged.

Note: the importer's node walk still reads only `node.translation`, not `node.matrix`. The
viewer's own "Export GLB" (from-meshes) emits only translations, so it round-trips fully. The
from-bytes instanced exporter emits per-occurrence node matrices; round-tripping those is a
follow-up that lands with the instancing work.
