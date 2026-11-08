---
"@ifc-lite/renderer": patch
---

Feature edges no longer draw as dotted lines along long straight edges. The edge pass darkened a pixel by the share of its tap directions that crossed an edge. Beside a slanted edge, the pixel at each step of the raster staircase sees the other side in two directions instead of one, so it drew twice as dark: the top of a wall seen in perspective came out as a row of dots, at `low` and `high` quality alike. A pixel is now on the line when any tap crosses an edge, and every line pixel darkens by the same amount, the weight an axis-aligned edge already had (`intensity` x 1/4 at `low`, x 3/8 at `high`). Axis-aligned edges look the same as before. The pass still reads only the visible depth and object-id buffers, so hidden geometry draws no edge.
