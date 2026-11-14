---
"@ifc-lite/viewer": patch
---

Work that waits for a load to settle now also waits until the viewport has drawn the settled scene. The cache write, the placed spatial index, the location map and the load window's release of held values (status counts, model statistics, overlays) run after a live frame was submitted since the scene settled, or after two animation frames with nothing to draw. A 1 s backstop covers hidden tabs and draws that never submit. Before this, a settle check that landed between finalize and that frame ran its work first: on large models the cache write's encode (80-200 ms) froze the frame that shows the finished model.
