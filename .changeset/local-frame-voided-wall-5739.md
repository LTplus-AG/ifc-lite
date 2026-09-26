---
"@ifc-lite/wasm": patch
---

More plan-rotated walls with openings now come out closed in the viewer. The viewer stores each element's vertices relative to its own origin. The wall-frame cut judged its closure before rotating back and removing degenerate slivers, and its snap tolerance came from those local coordinates, so walls the native path closed could stay open. Both decisions now use world-equivalent terms. One case remains: a wall whose analytic cut passes its seam-tolerant check only in the viewer's frame can still keep seams there.
