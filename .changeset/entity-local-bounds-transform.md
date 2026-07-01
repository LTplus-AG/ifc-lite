---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/renderer": minor
---

feat(renderer): expose per-element local (object-space) bounding box + placement transform

Recovering an element's TRUE oriented dimensions (length/width/height for a
rotated/tilted member) previously required an expensive client-side vertex
scan + PCA, since `Scene.getEntityBoundingBox` only returns a world-space
(axis-aligned-to-world) AABB. The geometry pipeline already resolves each
element's placement and briefly holds its pre-placement, object-space extent —
this surfaces both instead of discarding them (issue #1474):

- `Scene.getEntityLocalBounds(expressId)` — the element's local (pre-placement)
  AABB, O(1) lookup. Unions across a multi-piece entity's mesh pieces (material
  layers, CSG parts) — all pieces of one element share a local frame, so no
  reconciliation is needed. For a GPU-instanced entity, returns the shared
  template's local box.
- `Scene.getEntityTransform(expressId)` — the resolved `IfcLocalPlacement`
  chain, row-major 4×4, Y-up metres. For an instanced entity, returns the
  specific occurrence's transform.
- `MeshData` gains `localBounds`/`localToWorld` (optional, session-only — not
  persisted to the disk/IndexedDB geometry cache, recomputed fresh each load
  like GPU-instancing metadata).

Both return `null` for a container/assembly with no mesh (e.g.
`IfcElementAssembly`) or when not captured (older cached geometry). Consumers
can pair the two to reconstruct an oriented bounding box, or use it as a
fallback when `Qto_*` `Length`/`Width`/`Height` quantities are absent.
