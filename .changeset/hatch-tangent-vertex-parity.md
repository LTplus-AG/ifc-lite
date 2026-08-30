---
'@ifc-lite/drawing-2d': minor
---

Fix hatch fill escaping a polygon's boundary when a vertex or a whole edge lies exactly on a hatch line.

`clipLineToRing` collected the hatch line's intersections with each ring edge and then discarded any that shared a parameter with the previous one. That dedupe is right for a vertex the boundary passes straight through — two edges meet the line there and it is one crossing — but wrong for a vertex the boundary only touches, where the ring stays on one side and the correct count is zero net crossings. Collapsing a tangent touch to a single crossing inverted the inside/outside parity for every hatch segment after it, so fill ran outside the shape: for a 10x10 square with a notch touching `y=5`, the segment at that height extended to `x = -21.2` instead of stopping at the boundary. The sweep steps from the polygon's bounding-box minimum, so at an axis-aligned hatch angle its first line lands exactly on the shape's extreme boundary — this was not a rare configuration.

An edge is now counted as a crossing only when its two endpoints fall on opposite sides of the hatch line, and the crossing point is interpolated from those same two side values. A tangent touch contributes an even number of crossings and so leaves parity alone; a pass-through contributes one. Deriving the crossing from the side values rather than from a separate segment-intersection solve is what makes an edge lying flush along the hatch line work: its endpoints are a few ULPs either side of the line, which a cross-product test reports as parallel and drops, losing a crossing the side test had counted and inverting parity for the rest of the row.

The tie-break for a point exactly on the line is a consistent infinitesimal displacement of the line towards one side, so a hatch line lying exactly along a ring edge now resolves to the outside of that ring. Two visible consequences for existing drawings: the first line of a sweep across an axis-aligned shape lies on that shape's boundary edge and is no longer emitted, and a line flush with a hole's near edge is kept rather than subtracted. Both lie on the boundary rather than inside anything, but both change the emitted line set, which is why this is a minor rather than a patch.

Not fixed here: a hatch line can still be painted across a hole when the segment handed to the hole clip begins exactly on that hole's boundary. That predates this change and is unaffected by it.
