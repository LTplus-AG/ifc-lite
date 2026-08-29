---
'@ifc-lite/drawing-2d': patch
---

Fix hatch fill escaping a polygon's boundary when a vertex lies exactly on a hatch line.

`clipLineToRing` collected the hatch line's intersections with each ring edge and then discarded any that shared a parameter with the previous one. That dedupe is right for a vertex the boundary passes straight through — two edges meet the line there and it is one crossing — but wrong for a vertex the boundary only touches, where the ring stays on one side and the correct count is zero net crossings. Collapsing a tangent touch to a single crossing inverted the inside/outside parity for every hatch segment after it, so fill ran outside the shape: for a 10×10 square with a notch touching `y=5`, the segment at that height extended to `x = -21.2` instead of stopping at the boundary.

Intersections are now classified by which side of the line the vertex's neighbouring points fall on, so a tangent touch contributes no parity change and a pass-through still contributes one.
