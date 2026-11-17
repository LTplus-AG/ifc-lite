---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

GPU picking for large models (#10264 S1). Models over the pick-mesh budget (500 missing per-piece pick meshes) no longer fall back to the CPU raycast: click, hover and rectangle picks draw the existing colour batches whole and read the entity from the per-vertex lane, with hide/isolate, section planes, extra planes, crop boxes and section exclusions applied on the GPU. A click reports the GPU's depth-reconstructed world point; on models that keep their CPU geometry, the picked entity alone is raycast on the CPU for its model index and representation item. Rectangle select on large models becomes pixel-exact and depth-tested instead of bounding-box based. The CPU raycast still answers when the batches cannot (pending rebuild, evicted batch, ids beyond the lane range, missing pipelines). Small models keep the per-piece path. The viewer adds the `__ifc_lite_pick_parity__` debug hook that compares the GPU pick with the CPU raycast over a grid.
