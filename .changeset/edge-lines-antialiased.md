---
"@ifc-lite/renderer": patch
---

Edge lines are antialiased and even along their length. A sloped crease drew as a row of dark ticks, aliased over the antialiased geometry. The edge pass averaged its tap directions' votes, so the pixel at each stair step, where two directions cross the edge, drew twice as dark, and it read only the first MSAA sample. It now tests every MSAA sample, puts a sample on a line when any direction crosses an edge, and darkens by the fraction of samples on one. Lines therefore have the same weight at every angle: axis-aligned lines are darker than before and sloped ones lighter. Silhouettes against the background are outlined on every side; before, only some sides were, through a sign error. On an RTX GPU at 2100×1350 the pass takes 2.2 ms instead of 1.7 ms.
