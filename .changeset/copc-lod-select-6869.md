---
"@ifc-lite/pointcloud": minor
---

Add renderer-agnostic view-dependent LOD selection for point octrees (#6869). `selectLod` frustum-culls, refines the node with the largest projected screen span first while it exceeds a pixel threshold and the node cap allows, and water-fills the point budget across the selection with per-node stride hints. `LodPacer` sizes a fast first pass to a time budget from a learned read rate (asymmetric EMA with outlier clipping), `shouldReplacePass` only replaces what is on screen with a better pass, and `createCopcLodTree` presents a partially loaded COPC hierarchy as LOD nodes.
