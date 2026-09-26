---
"@ifc-lite/wasm": patch
---

More plan-rotated walls with openings now come out closed in the viewer. The viewer stores each element's vertices relative to its own origin. For such walls, the wall-frame cut judged its closure before rotating back and removing degenerate slivers, and took its snap tolerance from those local coordinates. So walls the native path closed could stay open. Both decisions now use world-equivalent terms, only for elements stored this way; native output is unchanged. One case remains: a wall whose analytic cut passes its seam-tolerant check only in the viewer's frame can still keep seams there.
