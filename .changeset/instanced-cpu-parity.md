---
"@ifc-lite/renderer": patch
---

Bring GPU-instanced occurrences to full feature parity with the flat path so they
behave correctly across every consumer, not just the opaque render:

- **Hide / isolate**: a per-instance hidden flag (shader discard in both the render
  and pick passes) driven by `Scene.setInstancedVisibility(hiddenIds, isolatedIds)`,
  so hidden/isolated instanced elements neither draw nor are pickable.
- **Transparency**: a transparent instanced pipeline (alpha blend, no depth write) +
  a second instanced sub-pass for occurrences a lens-ghost / x-ray / compare override
  made translucent — previously they rendered solid. Zero-cost when nothing is ghosted.
- **CPU consumers**: a compact CPU view of the instanced templates (geometry +
  per-occurrence matrices) yields per-occurrence world AABBs (folded into
  `boundingBoxes`, so `getEntityBoundingBox` / bbox-raycast / BCF resolve instanced
  ids) and lazy on-demand `getInstancedMeshDataPieces` for exact raycast — wired into
  the raycast-engine (measure-snap, section-by-face) with a ray-AABB pre-cull. New
  `getInstancedEntityBounds`, `getInstancedEntityIds`, `getAllInstancedMeshData`,
  `isInstancedEntity` accessors. The memory win holds: geometry is materialized on
  demand, never retained as N full copies.
