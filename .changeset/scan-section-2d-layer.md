---
'@ifc-lite/drawing-2d': minor
---

Export `projectTo2DBasis` from the package root.

It already existed in `math.ts` and is used internally by `section-cutter.ts`
for face-picked custom-plane sections, but was never re-exported. The new
point-cloud "scan" layer on the 2D section view (issue #1805) needs it as a
consumer outside the package, to project retained scan points into the same
drawing-space coordinates the section cutter produces for custom (non-cardinal)
cut planes.
